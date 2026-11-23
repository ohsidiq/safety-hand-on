import { createHash } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import type { Tx } from "@soh/db";
import {
  ApiFailure,
  baseErrors,
  ErrorResponse,
  guard,
  json,
  ok,
  type Row,
  respondFailure,
  run,
  security,
  type V1,
} from "./route-kit.js";
import { addDays, checkContractor, mapWorkerError, sealNik, today, type WorkerDeps } from "./workers.js";

/**
 * Impor pekerja (API-003 §6, WF-API-011).
 * - dry_run memvalidasi tanpa menyimpan; galat per baris (nomor baris, field, kode) tanpa nilai sel.
 * - Satu baris gagal tidak membatalkan baris lain, kecuali all_or_nothing (422 IMPORT_VALIDATION_FAILED).
 * - Idempotency-Key wajib untuk impor sungguhan (API-000 §11): kunci sama + isi sama -> hasil semula; isi beda -> 422.
 * - NIK diproses seperti pembuatan pekerja (tersandi, tidak dicatat). Setiap pekerja teraudit worker.create,
 *   ringkasan teraudit worker.import.
 * Penyimpangan P0 (tercatat): isi CSV dikirim di badan JSON dan diproses sinkron (maks 1.000 baris) karena alur file
 * (API-000 §14) dan job asinkron (API-000 §12) belum dibangun.
 */

export const IMPORT_MAX_ROWS = 1000;
const MAX_CSV_CHARS = 1_000_000;

export const IMPORT_COLUMNS = {
  required: [
    "employee_number",
    "full_name",
    "employment_status",
    "join_date",
    "site_code",
    "department_code",
    "job_position_code",
  ],
  optional: ["division_code", "contractor_code", "phone", "email", "national_id"],
} as const;

/** Templat CSV (baris contoh sintetis). */
export function importTemplate(): string {
  const header = [...IMPORT_COLUMNS.required, ...IMPORT_COLUMNS.optional].join(",");
  const sample = "UJI-0001,Pekerja Sintetis Satu,PERMANENT,2026-01-05,SITE-1,PROD,OPR-AB,,,+6281200000001,,";
  return `${header}\r\n${sample}\r\n`;
}

/** Parser CSV RFC 4180 (koma, tanda kutip ganda, CRLF/LF). Mengembalikan baris berisi sel; null bila kutip tak tertutup. */
export function parseCsv(text: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (quoted) return null;
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export interface RowError {
  row: number;
  field?: string;
  code: string;
}

const EMP_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,29}$/;
const PHONE_RE = /^\+[1-9]\d{7,14}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set(["PERMANENT", "CONTRACT", "CONTRACTOR"]);

interface Lookups {
  sites: Map<string, { id: string; active: boolean }>;
  departments: Map<string, { id: string; active: boolean }>;
  divisions: Map<string, { id: string; active: boolean }>;
  positions: Map<string, { id: string; active: boolean }>;
  contractors: Map<string, { id: string; active: boolean }>;
}

async function loadLookups(tx: Tx): Promise<Lookups> {
  const q = async (sql: string) => (await tx.query<{ k: string; id: string; status: string }>(sql)).rows;
  const map = (rows: { k: string; id: string; status: string }[]) => {
    const m = new Map<string, { id: string; active: boolean }>();
    // kode unik hanya di antara yang aktif: utamakan yang aktif
    for (const r of rows.sort((a, b) => (a.status === "ACTIVE" ? 1 : 0) - (b.status === "ACTIVE" ? 1 : 0))) {
      m.set(r.k, { id: r.id, active: r.status === "ACTIVE" });
    }
    return m;
  };
  return {
    sites: map(await q("select code as k, id, status from site")),
    departments: map(await q("select site_id || '/' || code as k, id, status from department")),
    divisions: map(await q("select department_id || '/' || code as k, id, status from division")),
    positions: map(await q("select code as k, id, status from job_position")),
    contractors: map(await q("select code as k, id, status from contractor")),
  };
}

type Prepared = { ok: true; values: Row } | { ok: false; error: Omit<RowError, "row"> };

/** Validasi satu baris dan ubah kode menjadi id (API-003 §9). Tanpa menyentuh database selain peta kode. */
function prepareRow(cells: Record<string, string>, lk: Lookups, deps: WorkerDeps, orgId: string): Prepared {
  const v = (k: string) => (cells[k] ?? "").trim();
  const fail = (field: string, code: string): Prepared => ({ ok: false, error: { field, code } });
  for (const k of IMPORT_COLUMNS.required) if (!v(k)) return fail(k, "required");
  if (!EMP_RE.test(v("employee_number"))) return fail("employee_number", "invalid");
  const name = v("full_name");
  if (name.length < 2 || name.length > 150) return fail("full_name", "invalid_length");
  const status = v("employment_status").toUpperCase();
  if (!STATUSES.has(status)) return fail("employment_status", "invalid");
  const join = v("join_date");
  if (!DATE_RE.test(join) || Number.isNaN(Date.parse(`${join}T00:00:00Z`))) return fail("join_date", "invalid_date");
  if (join > addDays(today(), 1)) return fail("join_date", "too_far_in_future");
  if (v("phone") && !PHONE_RE.test(v("phone"))) return fail("phone", "invalid_e164");
  if (v("email") && !EMAIL_RE.test(v("email"))) return fail("email", "invalid");

  const site = lk.sites.get(v("site_code"));
  if (!site) return fail("site_code", "reference_not_found");
  if (!site.active) return fail("site_code", "inactive");
  const dep = lk.departments.get(`${site.id}/${v("department_code")}`);
  if (!dep) return fail("department_code", "DEPARTMENT_NOT_IN_SITE");
  if (!dep.active) return fail("department_code", "inactive");
  let divisionId: string | null = null;
  if (v("division_code")) {
    const div = lk.divisions.get(`${dep.id}/${v("division_code")}`);
    if (!div) return fail("division_code", "not_in_department");
    if (!div.active) return fail("division_code", "inactive");
    divisionId = div.id;
  }
  const pos = lk.positions.get(v("job_position_code"));
  if (!pos) return fail("job_position_code", "reference_not_found");
  if (!pos.active) return fail("job_position_code", "inactive");
  let contractorId: string | null = null;
  if (v("contractor_code")) {
    const ctr = lk.contractors.get(v("contractor_code"));
    if (!ctr) return fail("contractor_code", "reference_not_found");
    if (!ctr.active) return fail("contractor_code", "inactive");
    contractorId = ctr.id;
  }
  const bad = checkContractor(status, contractorId);
  if (bad) return fail("contractor_code", bad.code);
  const nik = sealNik(deps, orgId, v("national_id") || undefined);
  if (nik instanceof ApiFailure)
    return fail("national_id", nik.code === "SERVICE_UNAVAILABLE" ? "not_configured" : "must_be_16_digits");

  return {
    ok: true,
    values: {
      organization_id: orgId,
      employee_number: v("employee_number"),
      full_name: name,
      employment_status: status,
      join_date: join,
      site_id: site.id,
      department_id: dep.id,
      division_id: divisionId,
      job_position_id: pos.id,
      contractor_id: contractorId,
      phone: v("phone") || null,
      email: v("email") || null,
      ...nik,
    },
  };
}

/** Kode galat database per baris (tanpa nilai sel). */
function dbRowError(err: unknown): Omit<RowError, "row"> {
  const e = err as { code?: string; message?: string; constraint?: string };
  const mapped = mapWorkerError(e);
  if (mapped) {
    const d = mapped.details?.[0];
    const code = mapped.code === "VALIDATION_ERROR" ? (d?.issue ?? "invalid") : mapped.code;
    return d?.field ? { field: d.field, code } : { code };
  }
  if (e.code === "42501") return { field: "site_code", code: "SCOPE_DENIED" };
  if (e.code === "23514" || e.code === "23503" || e.code === "23505") return { code: "invalid" };
  throw err;
}

const ImportBody = z
  .object({
    csv: z.string().min(1).max(MAX_CSV_CHARS).openapi({ description: "Isi CSV UTF-8 sesuai templat (maks 1.000 baris data)" }),
    dry_run: z.boolean().default(true),
    all_or_nothing: z.boolean().default(false),
  })
  .openapi("WorkerImportRequest");

const ImportResult = z
  .object({
    id: z.uuid().nullable().openapi({ description: "null untuk dry_run" }),
    dry_run: z.boolean(),
    all_or_nothing: z.boolean(),
    status: z.enum(["VALIDATED", "COMPLETED", "REJECTED"]),
    total_rows: z.number().int(),
    created: z.number().int().openapi({ description: "Untuk dry_run: jumlah baris yang akan dibuat" }),
    failed: z.number().int(),
    errors: z.array(z.object({ row: z.number().int(), field: z.string().optional(), code: z.string() })),
    replayed: z.boolean().openapi({ description: "true bila hasil diambil dari permintaan sebelumnya (Idempotency-Key)" }),
  })
  .openapi("WorkerImportResult");

export function registerWorkerImport(v1: V1, deps: WorkerDeps) {
  const templateRoute = createRoute({
    method: "get",
    path: "/workers/imports/template",
    tags: ["Workers"],
    summary: "Templat CSV impor pekerja",
    security,
    middleware: guard(deps, "worker.create"),
    responses: {
      200: { content: { "text/csv": { schema: z.string() } }, description: "Templat CSV" },
      ...baseErrors,
    },
  });

  const importRoute = createRoute({
    method: "post",
    path: "/workers/imports",
    tags: ["Workers"],
    summary: "Impor pekerja dari CSV (dry_run, all_or_nothing). Idempotency-Key wajib bila dry_run=false",
    security,
    middleware: guard(deps, "worker.create"),
    request: {
      headers: z.object({ "idempotency-key": z.uuid().optional() }),
      body: { content: { "application/json": { schema: ImportBody } }, required: true },
    },
    responses: {
      200: json(ok(ImportResult), "Hasil validasi atau impor"),
      ...baseErrors,
      422: json(
        ErrorResponse,
        "VALIDATION_ERROR (format/kolom), IDEMPOTENCY_MISMATCH, IMPORT_VALIDATION_FAILED (all_or_nothing)",
      ),
      503: json(ErrorResponse, "SERVICE_UNAVAILABLE"),
    },
  });

  v1.openapi(templateRoute, (c) => {
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", 'attachment; filename="templat-impor-pekerja.csv"');
    return c.body(importTemplate(), 200) as never;
  });

  v1.openapi(importRoute, async (c) => {
    const body = c.req.valid("json");
    const key = c.req.valid("header")["idempotency-key"];
    const identity = c.get("identity");
    const orgId = identity.organizationId;
    if (!orgId) return respondFailure(c, new ApiFailure("FORBIDDEN"));
    if (!body.dry_run && !key) {
      return respondFailure(c, new ApiFailure("VALIDATION_ERROR", [{ field: "Idempotency-Key", issue: "required" }]));
    }

    const rows = parseCsv(body.csv);
    if (!rows || rows.length === 0)
      return respondFailure(c, new ApiFailure("VALIDATION_ERROR", [{ field: "csv", issue: "unreadable" }]));
    const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
    const known = new Set<string>([...IMPORT_COLUMNS.required, ...IMPORT_COLUMNS.optional]);
    const unknown = header.find((h) => !known.has(h));
    if (unknown)
      return respondFailure(
        c,
        new ApiFailure("VALIDATION_ERROR", [{ field: "csv", issue: `unknown_column:${unknown.slice(0, 40)}` }]),
      );
    const missing = IMPORT_COLUMNS.required.find((r) => !header.includes(r));
    if (missing)
      return respondFailure(c, new ApiFailure("VALIDATION_ERROR", [{ field: "csv", issue: `missing_column:${missing}` }]));
    const data = rows.slice(1);
    if (data.length === 0) return respondFailure(c, new ApiFailure("VALIDATION_ERROR", [{ field: "csv", issue: "no_rows" }]));
    if (data.length > IMPORT_MAX_ROWS)
      return respondFailure(c, new ApiFailure("PAYLOAD_TOO_LARGE", [{ field: "csv", issue: `max_rows:${IMPORT_MAX_ROWS}` }]));
    const requestHash = createHash("sha256")
      .update(JSON.stringify([body.csv, body.all_or_nothing]))
      .digest("hex");

    const r = await run(c, deps, async (tx) => {
      // Idempotency-Key: hasil semula bila kunci dan isi sama (API-000 §11)
      if (!body.dry_run) {
        const prev = await tx.query<Row & { request_hash: string }>(
          `select id, request_hash, all_or_nothing, status, total_rows, created_count, failed_count, errors
           from worker_import where idempotency_key = $1`,
          [key],
        );
        const p = prev.rows[0];
        if (p) {
          if (p.request_hash !== requestHash) throw new ApiFailure("IDEMPOTENCY_MISMATCH");
          return {
            id: p.id,
            dry_run: false,
            all_or_nothing: p.all_or_nothing,
            status: p.status,
            total_rows: p.total_rows,
            created: p.created_count,
            failed: p.failed_count,
            errors: p.errors,
            replayed: true,
          } as Row;
        }
      }

      const lk = await loadLookups(tx);
      const errors: RowError[] = [];
      let created = 0;
      await tx.query("savepoint import_all");
      for (let i = 0; i < data.length; i++) {
        const rowNo = i + 2; // baris 1 = header
        const cells: Record<string, string> = {};
        header.forEach((h, j) => {
          cells[h] = data[i]?.[j] ?? "";
        });
        const prepared = prepareRow(cells, lk, deps, orgId);
        if (!prepared.ok) {
          errors.push({ row: rowNo, ...prepared.error });
          continue;
        }
        const keys = Object.keys(prepared.values);
        await tx.query("savepoint import_row");
        try {
          await tx.query(
            `insert into worker (${keys.join(", ")}) values (${keys.map((_, k) => `$${k + 1}`).join(", ")})`,
            keys.map((k) => prepared.values[k]),
          );
          await tx.query("release savepoint import_row");
          created++;
        } catch (err) {
          await tx.query("rollback to savepoint import_row");
          errors.push({ row: rowNo, ...dbRowError(err) });
        }
      }
      const rejected = body.all_or_nothing && errors.length > 0;
      if (body.dry_run || rejected) await tx.query("rollback to savepoint import_all");
      const result: Row = {
        id: null,
        dry_run: body.dry_run,
        all_or_nothing: body.all_or_nothing,
        status: body.dry_run ? "VALIDATED" : rejected ? "REJECTED" : "COMPLETED",
        total_rows: data.length,
        created: rejected ? 0 : created,
        failed: errors.length,
        errors,
        replayed: false,
      };
      if (!body.dry_run) {
        const ins = await tx.query<{ id: string }>(
          `insert into worker_import (organization_id, idempotency_key, request_hash, all_or_nothing, status, total_rows,
                                      created_count, failed_count, errors, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
          [
            orgId,
            key,
            requestHash,
            body.all_or_nothing,
            result.status,
            data.length,
            result.created,
            errors.length,
            JSON.stringify(errors),
            identity.userId,
          ],
        );
        result.id = ins.rows[0]?.id ?? null;
      }
      return result;
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    if (r.status === "REJECTED") {
      return respondFailure(
        c,
        new ApiFailure("IMPORT_VALIDATION_FAILED", [{ field: "csv", issue: "rows_failed" }], { result: r }),
      );
    }
    return c.json({ success: true, data: r, request_id: c.get("requestId") }, 200);
  });
}

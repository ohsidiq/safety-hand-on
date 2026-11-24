import { createRoute, z } from "@hono/zod-openapi";
import type { Tx } from "@soh/db";
import { safeFileName } from "./files.js";
import {
  ApiFailure,
  baseErrors,
  type Deps,
  ErrorResponse,
  guard,
  guardSelf,
  IfMatch,
  json,
  list,
  ok,
  parseIfMatch,
  type Row,
  respondFailure,
  run,
  security,
  serialize,
  type V1,
} from "./route-kit.js";
import { type FileStorage, StorageError } from "./storage.js";

/**
 * Kompetensi pekerja, sertifikat, dan verifikasi (API-004 §3-§5, SRS-WF003, DB-003 §2.1).
 * - Record baru selalu PENDING. Perubahan data inti / sertifikat baru pada record VERIFIED/REJECTED -> PENDING (pemicu DB, WR-004).
 * - verify/reject hanya dari PENDING (409 INVALID_STATE_TRANSITION); pemverifikasi bukan pembuat (403 SEPARATION_OF_DUTIES,
 *   juga CHECK database). HSE Officer (competency.verify LIMITED) tidak dapat memverifikasi.
 * - WORKER competency.update SELF: mencatat dan memperbaiki kompetensinya sendiri; tidak dapat memverifikasi (RLS).
 * - validity_status dihitung dari tanggal lokal Site (app.site_today); informasi, bukan penentu kesiapan.
 * Belum di M3.2: evaluasi readiness setelah verifikasi/penolakan (CMP-API-010, Readiness Engine M4), CERTIFICATE_REQUIRED
 * (atribut master belum ada), Idempotency-Key pada POST record (duplikat sertifikat dicegah unik file_id).
 */

export type CompetencyDeps = Deps & { storage?: FileStorage | undefined };

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Source = z.enum(["CERTIFICATE", "TRAINING", "ASSESSMENT", "OTHER"]);
const VerificationStatus = z.enum(["PENDING", "VERIFIED", "REJECTED"]);
const ValidityStatus = z.enum(["VALID", "EXPIRING_SOON", "EXPIRED", "PENDING_VERIFICATION", "REJECTED"]);
export const EXPIRING_SOON_DAYS = 30;

const WorkerCompetency = z
  .object({
    id: z.uuid(),
    worker_id: z.uuid(),
    site_id: z.uuid(),
    worker_name: z.string().nullable().openapi({ description: "null bila pemanggil tidak dapat membaca data pekerja" }),
    sho_id: z.string().nullable(),
    competency: z.object({ id: z.uuid(), name: z.string().nullable(), code: z.string().nullable() }),
    valid_from: z.string(),
    valid_until: z.string().nullable(),
    source: Source,
    verification_status: VerificationStatus,
    validity_status: ValidityStatus,
    verified_by: z.uuid().nullable(),
    verified_by_name: z.string().nullable(),
    verified_at: z.string().nullable(),
    verification_comment: z.string().nullable(),
    rejection_reason: z.string().nullable(),
    created_by: z.uuid(),
    created_by_name: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    version: z.number().int(),
    certificate_count: z.number().int(),
    can_verify: z
      .boolean()
      .openapi({ description: "Pemanggil boleh memverifikasi (PENDING, bukan pembuat, punya competency.verify)" }),
  })
  .openapi("WorkerCompetency");

const Certificate = z
  .object({
    id: z.uuid(),
    worker_competency_id: z.uuid(),
    certificate_number: z.string().nullable(),
    issuer: z.string().nullable(),
    issue_date: z.string(),
    expiry_date: z.string().nullable(),
    file_id: z.uuid().nullable(),
    file_name: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("CompetencyCertificate");

const CertificateInput = z
  .object({
    certificate_number: z.string().trim().max(100).nullable().optional(),
    issuer: z.string().trim().max(150).nullable().optional(),
    issue_date: IsoDate,
    expiry_date: IsoDate.nullable().optional(),
    file_id: z.uuid(),
  })
  .openapi("CompetencyCertificateCreate");

const validity = `case
    when wc.verification_status = 'REJECTED' then 'REJECTED'
    when wc.verification_status = 'PENDING' then 'PENDING_VERIFICATION'
    when wc.valid_until is not null and wc.valid_until < app.site_today(wc.site_id) then 'EXPIRED'
    when wc.valid_until is not null and wc.valid_until <= app.site_today(wc.site_id) + ${EXPIRING_SOON_DAYS} then 'EXPIRING_SOON'
    else 'VALID' end`;

/** $1 = id pengguna pemanggil (can_verify), $2 = apakah pemanggil punya competency.verify. */
const SELECT = `select wc.id, wc.worker_id, wc.site_id, w.full_name as worker_name, w.sho_id,
    json_build_object('id', wc.competency_id, 'name', c.name, 'code', c.code) as competency,
    wc.valid_from::text as valid_from, wc.valid_until::text as valid_until, wc.source, wc.verification_status,
    ${validity} as validity_status, wc.verified_by, vb.full_name as verified_by_name, wc.verified_at,
    wc.verification_comment, wc.rejection_reason, wc.created_by, cb.full_name as created_by_name, wc.created_at, wc.updated_at,
    wc.version, (select count(*) from competency_certificate cc where cc.worker_competency_id = wc.id)::int as certificate_count,
    (wc.verification_status = 'PENDING' and wc.created_by <> $1::uuid and $2::boolean) as can_verify
  from worker_competency wc
  left join competency c on c.id = wc.competency_id
  left join worker w on w.id = wc.worker_id
  left join user_profile vb on vb.id = wc.verified_by
  left join user_profile cb on cb.id = wc.created_by`;

const CERT_SELECT = `select cc.id, cc.worker_competency_id, cc.certificate_number, cc.issuer, cc.issue_date::text as issue_date,
    cc.expiry_date::text as expiry_date, cc.file_id, f.original_name as file_name, cc.created_at
  from competency_certificate cc left join file_object f on f.id = cc.file_id`;

const IdParam = z.object({ id: z.uuid() });
const WorkerParam = z.object({ worker_id: z.uuid() });

function mapCompetencyError(e: { code?: string; message?: string; constraint?: string }): ApiFailure | undefined {
  const msg = e.message ?? "";
  if (e.code === "23514") {
    if (msg.startsWith("INVALID_STATE_TRANSITION")) return new ApiFailure("INVALID_STATE_TRANSITION");
    if (msg.startsWith("FILE_NOT_CLEAN")) return new ApiFailure("FILE_NOT_CLEAN", [{ field: "file_id", issue: "not_clean" }]);
    if (e.constraint === "worker_competency_range_chk")
      return new ApiFailure("INVALID_DATE_RANGE", [{ field: "valid_until", issue: "before_valid_from" }]);
    if (e.constraint === "competency_certificate_range_chk")
      return new ApiFailure("INVALID_DATE_RANGE", [{ field: "expiry_date", issue: "before_issue_date" }]);
    if (e.constraint === "worker_competency_sod_chk") return new ApiFailure("SEPARATION_OF_DUTIES");
    if (e.constraint === "worker_competency_rejected_chk")
      return new ApiFailure("REASON_REQUIRED", [{ field: "reason", issue: "required" }]);
  }
  if (e.code === "23505" && e.constraint === "competency_certificate_file_uq")
    return new ApiFailure("DUPLICATE", [{ field: "file_id", issue: "already_used" }]);
  if (e.code === "23503") return new ApiFailure("VALIDATION_ERROR", [{ field: "file_id", issue: "reference_not_found" }]);
  return undefined;
}

function checkRange(from: string, until: string | null | undefined, field = "valid_until"): ApiFailure | null {
  if (until && until < from) return new ApiFailure("INVALID_DATE_RANGE", [{ field, issue: "before_start" }]);
  return null;
}

async function loadOne(tx: Tx, id: string, me: string, canVerify: boolean): Promise<Row> {
  const r = await tx.query(`${SELECT} where wc.id = $3`, [me, canVerify, id]);
  if (!r.rows[0]) throw new ApiFailure("NOT_FOUND");
  return r.rows[0] as Row;
}

async function insertCertificates(tx: Tx, orgId: string, wcId: string, me: string, certs: z.infer<typeof CertificateInput>[]) {
  for (const [i, cert] of certs.entries()) {
    const bad = checkRange(cert.issue_date, cert.expiry_date, `certificates[${i}].expiry_date`);
    if (bad) throw bad;
    await tx.query(
      `insert into competency_certificate (organization_id, worker_competency_id, certificate_number, issuer, issue_date,
         expiry_date, file_id, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        orgId,
        wcId,
        cert.certificate_number ?? null,
        cert.issuer ?? null,
        cert.issue_date,
        cert.expiry_date ?? null,
        cert.file_id,
        me,
      ],
    );
  }
}

export function registerCompetencies(v1: V1, deps: CompetencyDeps) {
  const errs = {
    ...baseErrors,
    404: json(ErrorResponse, "NOT_FOUND (tidak ada atau di luar scope)"),
    409: json(ErrorResponse, "INVALID_STATE_TRANSITION, DUPLICATE"),
    412: json(ErrorResponse, "VERSION_CONFLICT (disertai current_version)"),
    422: json(ErrorResponse, "VALIDATION_ERROR, INVALID_DATE_RANGE, REASON_REQUIRED, FILE_NOT_CLEAN"),
  };
  const canVerify = (c: { get: (k: "identity") => { permissions: ReadonlySet<string> } }) =>
    c.get("identity").permissions.has("competency.verify");

  // ---------------------------------------------------------------- antrean verifikasi (didaftarkan sebelum /competencies/{id})
  const queueRoute = createRoute({
    method: "get",
    path: "/competencies/pending-verification",
    tags: ["Competency"],
    summary: "Antrean verifikasi kompetensi (PENDING, terlama dahulu)",
    security,
    middleware: guard(deps, "competency.verify"),
    request: {
      query: z.object({
        site_id: z.uuid().optional(),
        competency_id: z.uuid().optional(),
        submitted_before: z.iso.datetime({ offset: true }).optional(),
        cursor: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
    },
    responses: { 200: json(list(WorkerCompetency), "Antrean"), ...baseErrors, 422: json(ErrorResponse, "VALIDATION_ERROR") },
  });
  v1.openapi(queueRoute, async (c) => {
    const q = c.req.valid("query");
    const me = c.get("identity").userId;
    let after: { t: string; id: string } | null = null;
    if (q.cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(q.cursor, "base64url").toString("utf8")) as { t?: unknown; id?: unknown };
        if (typeof parsed.t !== "string" || typeof parsed.id !== "string" || !/^[0-9a-f-]{36}$/.test(parsed.id))
          throw new Error();
        after = { t: parsed.t, id: parsed.id };
      } catch {
        return respondFailure(c, new ApiFailure("VALIDATION_ERROR", [{ field: "cursor", issue: "invalid" }]));
      }
    }
    const r = await run(c, deps, async (tx) => {
      const params: unknown[] = [me, true];
      const where = ["wc.verification_status = 'PENDING'"];
      const add = (sql: string, v: unknown) => {
        params.push(v);
        where.push(sql.replace("?", `$${params.length}`));
      };
      if (q.site_id) add("wc.site_id = ?", q.site_id);
      if (q.competency_id) add("wc.competency_id = ?", q.competency_id);
      if (q.submitted_before) add("wc.updated_at < ?::timestamptz", q.submitted_before);
      if (after) {
        params.push(after.t, after.id);
        where.push(`(wc.updated_at, wc.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
      }
      const res = await tx.query(
        `${SELECT} where ${where.join(" and ")} order by wc.updated_at, wc.id limit ${q.limit + 1}`,
        params,
      );
      return res.rows as Row[];
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    const hasMore = r.length > q.limit;
    const page = r.slice(0, q.limit);
    const last = page[page.length - 1];
    const next =
      hasMore && last
        ? Buffer.from(JSON.stringify({ t: (last.updated_at as Date).toISOString(), id: last.id })).toString("base64url")
        : null;
    return c.json(
      {
        success: true,
        data: page.map(serialize),
        pagination: { limit: q.limit, next_cursor: next, has_more: hasMore },
        request_id: c.get("requestId"),
      },
      200,
    );
  });

  // ---------------------------------------------------------------- kompetensi milik pekerja
  const listRoute = createRoute({
    method: "get",
    path: "/workers/{worker_id}/competencies",
    tags: ["Competency"],
    summary: "Kompetensi pekerja (semua riwayat, terbaru dahulu)",
    security,
    middleware: guardSelf(deps, "competency.read"),
    request: { params: WorkerParam },
    responses: { 200: json(list(WorkerCompetency), "Kompetensi"), ...baseErrors, 404: json(ErrorResponse, "NOT_FOUND") },
  });
  v1.openapi(listRoute, async (c) => {
    const { worker_id } = c.req.valid("param");
    const me = c.get("identity").userId;
    const r = await run(c, deps, async (tx) => {
      const res = await tx.query(`${SELECT} where wc.worker_id = $3 order by wc.valid_from desc, wc.created_at desc limit 501`, [
        me,
        canVerify(c),
        worker_id,
      ]);
      if (res.rows.length === 0) {
        // pekerja tanpa kompetensi vs pekerja di luar scope: keduanya tanpa data; yang tak terlihat -> 404
        const w = await tx.query("select 1 from worker where id = $1", [worker_id]);
        if (!w.rows[0]) throw new ApiFailure("NOT_FOUND");
      }
      return res.rows as Row[];
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return c.json(
      {
        success: true,
        data: r.slice(0, 500).map(serialize),
        pagination: { limit: 500, next_cursor: null, has_more: r.length > 500 },
        request_id: c.get("requestId"),
      },
      200,
    );
  });

  const createRec = createRoute({
    method: "post",
    path: "/workers/{worker_id}/competencies",
    tags: ["Competency"],
    summary: "Mencatat kompetensi pekerja (PENDING), opsional beserta sertifikat",
    security,
    middleware: guardSelf(deps, "competency.update"),
    request: {
      params: WorkerParam,
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                competency_id: z.uuid(),
                valid_from: IsoDate,
                valid_until: IsoDate.nullable().optional(),
                source: Source.default("CERTIFICATE"),
                certificates: z.array(CertificateInput).max(5).default([]),
              })
              .openapi("WorkerCompetencyCreate"),
          },
        },
        required: true,
      },
    },
    responses: { 201: json(ok(WorkerCompetency), "Dicatat"), ...errs },
  });
  v1.openapi(createRec, async (c) => {
    const { worker_id } = c.req.valid("param");
    const b = c.req.valid("json");
    const identity = c.get("identity");
    const orgId = identity.organizationId;
    if (!orgId) return respondFailure(c, new ApiFailure("FORBIDDEN"));
    const bad = checkRange(b.valid_from, b.valid_until);
    if (bad) return respondFailure(c, bad);
    const r = await run(
      c,
      deps,
      async (tx) => {
        const w = await tx.query<{ site_id: string; today: string }>(
          "select site_id, app.site_today(site_id)::text as today from worker where id = $1",
          [worker_id],
        );
        const wr = w.rows[0];
        if (!wr) throw new ApiFailure("NOT_FOUND");
        if (b.valid_from > wr.today) throw new ApiFailure("VALIDATION_ERROR", [{ field: "valid_from", issue: "in_future" }]);
        const cm = await tx.query<{ status: string }>("select status from competency where id = $1", [b.competency_id]);
        if (cm.rows[0]?.status !== "ACTIVE")
          throw new ApiFailure("VALIDATION_ERROR", [{ field: "competency_id", issue: cm.rows[0] ? "inactive" : "not_found" }]);
        const ins = await tx.query<{ id: string }>(
          `insert into worker_competency (organization_id, site_id, worker_id, competency_id, valid_from, valid_until, source, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
          [orgId, wr.site_id, worker_id, b.competency_id, b.valid_from, b.valid_until ?? null, b.source, identity.userId],
        );
        const id = ins.rows[0]?.id as string;
        await insertCertificates(tx, orgId, id, identity.userId, b.certificates);
        return loadOne(tx, id, identity.userId, canVerify(c));
      },
      { map: mapCompetencyError },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("ETag", `"${r.version}"`);
    c.header("Location", `/api/v1/worker-competencies/${r.id}`);
    return c.json({ success: true, data: serialize(r), request_id: c.get("requestId") }, 201);
  });

  const getRec = createRoute({
    method: "get",
    path: "/worker-competencies/{id}",
    tags: ["Competency"],
    summary: "Detail kompetensi pekerja",
    security,
    middleware: guardSelf(deps, "competency.read"),
    request: { params: IdParam },
    responses: { 200: json(ok(WorkerCompetency), "Kompetensi"), ...baseErrors, 404: json(ErrorResponse, "NOT_FOUND") },
  });
  v1.openapi(getRec, async (c) => {
    const { id } = c.req.valid("param");
    const r = await run(c, deps, (tx) => loadOne(tx, id, c.get("identity").userId, canVerify(c)));
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("ETag", `"${r.version}"`);
    return c.json({ success: true, data: serialize(r), request_id: c.get("requestId") }, 200);
  });

  const patchRec = createRoute({
    method: "patch",
    path: "/worker-competencies/{id}",
    tags: ["Competency"],
    summary: "Mengubah kompetensi pekerja (data inti pada record terverifikasi/ditolak -> PENDING)",
    security,
    middleware: guardSelf(deps, "competency.update"),
    request: {
      params: IdParam,
      headers: IfMatch,
      body: {
        content: {
          "application/json": {
            schema: z
              .object({ valid_from: IsoDate.optional(), valid_until: IsoDate.nullable().optional(), source: Source.optional() })
              .openapi("WorkerCompetencyPatch"),
          },
        },
        required: true,
      },
    },
    responses: { 200: json(ok(WorkerCompetency), "Kompetensi"), ...errs },
  });
  v1.openapi(patchRec, async (c) => {
    const { id } = c.req.valid("param");
    const expected = parseIfMatch(c.req.valid("header")["if-match"]);
    const b = c.req.valid("json");
    const me = c.get("identity").userId;
    const r = await run(
      c,
      deps,
      async (tx) => {
        const cur = await tx.query<{ version: number; valid_from: string; valid_until: string | null; today: string }>(
          `select version, valid_from::text as valid_from, valid_until::text as valid_until, app.site_today(site_id)::text as today
             from worker_competency where id = $1`,
          [id],
        );
        const row = cur.rows[0];
        if (!row) throw new ApiFailure("NOT_FOUND");
        if (expected !== row.version) throw new ApiFailure("VERSION_CONFLICT", undefined, { current_version: row.version });
        const from = b.valid_from ?? row.valid_from;
        const until = b.valid_until === undefined ? row.valid_until : b.valid_until;
        const bad = checkRange(from, until);
        if (bad) throw bad;
        if (b.valid_from && b.valid_from > row.today)
          throw new ApiFailure("VALIDATION_ERROR", [{ field: "valid_from", issue: "in_future" }]);
        const set: Row = {};
        if (b.valid_from !== undefined) set.valid_from = b.valid_from;
        if (b.valid_until !== undefined) set.valid_until = b.valid_until;
        if (b.source !== undefined) set.source = b.source;
        const keys = Object.keys(set);
        if (keys.length) {
          const res = await tx.query(
            `update worker_competency set ${keys.map((k, i) => `${k} = $${i + 3}`).join(", ")} where id = $1 and version = $2`,
            [id, row.version, ...keys.map((k) => set[k])],
          );
          if (res.rowCount === 0) {
            const again = await tx.query<{ version: number }>("select version from worker_competency where id = $1", [id]);
            const v = again.rows[0]?.version;
            if (v !== undefined && v !== row.version) throw new ApiFailure("VERSION_CONFLICT", undefined, { current_version: v });
            throw new ApiFailure("SCOPE_DENIED");
          }
        }
        return loadOne(tx, id, me, canVerify(c));
      },
      { map: mapCompetencyError },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("ETag", `"${r.version}"`);
    return c.json({ success: true, data: serialize(r), request_id: c.get("requestId") }, 200);
  });

  // ---------------------------------------------------------------- verifikasi
  for (const action of ["verify", "reject"] as const) {
    const body =
      action === "verify"
        ? z.object({ comment: z.string().trim().max(500).optional() }).openapi("CompetencyVerify")
        : z.object({ reason: z.string().trim().max(500).optional() }).openapi("CompetencyReject");
    const route = createRoute({
      method: "post",
      path: `/worker-competencies/{id}/${action}`,
      tags: ["Competency"],
      summary: action === "verify" ? "Memverifikasi kompetensi (bukan pembuat)" : "Menolak kompetensi (alasan wajib)",
      security,
      middleware: guard(deps, "competency.verify"),
      request: { params: IdParam, headers: IfMatch, body: { content: { "application/json": { schema: body } }, required: true } },
      responses: {
        200: json(ok(WorkerCompetency), "Hasil verifikasi"),
        ...errs,
        403: json(ErrorResponse, "FORBIDDEN, SCOPE_DENIED, SEPARATION_OF_DUTIES"),
      },
    });
    v1.openapi(route, async (c) => {
      const { id } = c.req.valid("param");
      const expected = parseIfMatch(c.req.valid("header")["if-match"]);
      const b = c.req.valid("json") as { comment?: string; reason?: string };
      const me = c.get("identity").userId;
      const reason = b.reason?.trim();
      if (action === "reject" && !reason)
        return respondFailure(c, new ApiFailure("REASON_REQUIRED", [{ field: "reason", issue: "required" }]));
      const r = await run(
        c,
        deps,
        async (tx) => {
          const cur = await tx.query<{ version: number; verification_status: string; created_by: string }>(
            "select version, verification_status, created_by from worker_competency where id = $1",
            [id],
          );
          const row = cur.rows[0];
          if (!row) throw new ApiFailure("NOT_FOUND");
          if (expected !== row.version) throw new ApiFailure("VERSION_CONFLICT", undefined, { current_version: row.version });
          if (row.verification_status !== "PENDING")
            throw new ApiFailure("INVALID_STATE_TRANSITION", [{ field: "verification_status", issue: row.verification_status }]);
          if (row.created_by === me) throw new ApiFailure("SEPARATION_OF_DUTIES");
          const res =
            action === "verify"
              ? await tx.query(
                  `update worker_competency set verification_status = 'VERIFIED', verified_by = $3, verified_at = now(),
                     verification_comment = $4, rejection_reason = null where id = $1 and version = $2`,
                  [id, row.version, me, b.comment?.trim() || null],
                )
              : await tx.query(
                  `update worker_competency set verification_status = 'REJECTED', verified_by = $3, verified_at = now(),
                     rejection_reason = $4, verification_comment = null where id = $1 and version = $2`,
                  [id, row.version, me, reason],
                );
          if (res.rowCount === 0) throw new ApiFailure("SCOPE_DENIED");
          return loadOne(tx, id, me, canVerify(c));
        },
        { map: mapCompetencyError },
      );
      if (r instanceof ApiFailure) return respondFailure(c, r);
      c.header("ETag", `"${r.version}"`);
      return c.json({ success: true, data: serialize(r), request_id: c.get("requestId") }, 200);
    });
  }

  // ---------------------------------------------------------------- sertifikat
  const listCerts = createRoute({
    method: "get",
    path: "/worker-competencies/{id}/certificates",
    tags: ["Competency"],
    summary: "Sertifikat kompetensi",
    security,
    middleware: guardSelf(deps, "competency.read"),
    request: { params: IdParam },
    responses: { 200: json(list(Certificate), "Sertifikat"), ...baseErrors, 404: json(ErrorResponse, "NOT_FOUND") },
  });
  v1.openapi(listCerts, async (c) => {
    const { id } = c.req.valid("param");
    const r = await run(c, deps, async (tx) => {
      const p = await tx.query("select 1 from worker_competency where id = $1", [id]);
      if (!p.rows[0]) throw new ApiFailure("NOT_FOUND");
      const res = await tx.query(
        `${CERT_SELECT} where cc.worker_competency_id = $1 order by cc.issue_date desc, cc.created_at desc`,
        [id],
      );
      return res.rows as Row[];
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return c.json(
      {
        success: true,
        data: r.map(serialize),
        pagination: { limit: r.length, next_cursor: null, has_more: false },
        request_id: c.get("requestId"),
      },
      200,
    );
  });

  const addCert = createRoute({
    method: "post",
    path: "/worker-competencies/{id}/certificates",
    tags: ["Competency"],
    summary: "Menambah sertifikat (berkas CLEAN); record terverifikasi kembali PENDING",
    security,
    middleware: guardSelf(deps, "competency.update"),
    request: { params: IdParam, body: { content: { "application/json": { schema: CertificateInput } }, required: true } },
    responses: { 201: json(ok(Certificate), "Sertifikat ditambahkan"), ...errs },
  });
  v1.openapi(addCert, async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const identity = c.get("identity");
    const orgId = identity.organizationId;
    if (!orgId) return respondFailure(c, new ApiFailure("FORBIDDEN"));
    const r = await run(
      c,
      deps,
      async (tx) => {
        const p = await tx.query("select 1 from worker_competency where id = $1", [id]);
        if (!p.rows[0]) throw new ApiFailure("NOT_FOUND");
        await insertCertificates(tx, orgId, id, identity.userId, [b]);
        const res = await tx.query(`${CERT_SELECT} where cc.file_id = $1`, [b.file_id]);
        return res.rows[0] as Row;
      },
      { map: mapCompetencyError },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return c.json({ success: true, data: serialize(r), request_id: c.get("requestId") }, 201);
  });

  const download = createRoute({
    method: "get",
    path: "/competency-certificates/{id}/download-url",
    tags: ["Competency"],
    summary: "URL unduh sertifikat bertanda tangan berumur pendek (teraudit)",
    security,
    middleware: guardSelf(deps, "competency.read"),
    request: { params: IdParam },
    responses: {
      200: json(ok(z.object({ url: z.string(), expires_in: z.number().int() })), "URL unduh"),
      ...baseErrors,
      404: json(ErrorResponse, "NOT_FOUND (sertifikat tanpa berkas atau di luar scope)"),
      422: json(ErrorResponse, "FILE_NOT_CLEAN"),
      503: json(ErrorResponse, "SERVICE_UNAVAILABLE (penyimpanan)"),
    },
  });
  v1.openapi(download, async (c) => {
    const { id } = c.req.valid("param");
    const storage = deps.storage;
    if (!storage)
      return respondFailure(c, new ApiFailure("SERVICE_UNAVAILABLE", [{ field: "storage", issue: "not_configured" }]));
    const r = await run(c, deps, async (tx) => {
      const res = await tx.query<{
        worker_competency_id: string;
        file_id: string | null;
        bucket: string | null;
        object_path: string | null;
        original_name: string | null;
        scan_status: string | null;
      }>(
        `select cc.worker_competency_id, cc.file_id, f.bucket, f.object_path, f.original_name, f.scan_status
           from competency_certificate cc left join file_object f on f.id = cc.file_id where cc.id = $1`,
        [id],
      );
      const row = res.rows[0];
      if (!row?.file_id || !row.bucket || !row.object_path) throw new ApiFailure("NOT_FOUND");
      if (row.scan_status !== "CLEAN") throw new ApiFailure("FILE_NOT_CLEAN");
      const ttl = 300;
      await tx.query(
        "select app.audit_record('competency.certificate_download', 'worker_competency', $1, null, null, null, null, 'SUCCESS', false)",
        [row.worker_competency_id],
      );
      try {
        return {
          url: await storage.createDownloadUrl(row.bucket, row.object_path, ttl, safeFileName(row.original_name ?? "sertifikat")),
          expires_in: ttl,
        };
      } catch (err) {
        if (err instanceof StorageError) throw new ApiFailure("SERVICE_UNAVAILABLE", [{ field: "storage", issue: "upstream" }]);
        throw err;
      }
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, data: r, request_id: c.get("requestId") }, 200);
  });
}

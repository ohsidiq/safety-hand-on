import { randomBytes, randomUUID } from "node:crypto";
import { createPool, type Db } from "@soh/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/create-app.js";
import { createNationalIdCrypto } from "../src/national-id.js";
import { importTemplate, parseCsv } from "../src/worker-import.js";
import { makeIssuer } from "./jwt-helper.js";

/** Impor pekerja (API-003 §6, WF-API-011). Unit parser + integrasi (butuh DATABASE_URL). */

describe("parser CSV impor", () => {
  it("tanda kutip, koma di dalam sel, CRLF, BOM, baris kosong", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\n\n1,2')).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"'],
      ["1", "2"],
    ]);
    expect(parseCsv('a,"b')).toBeNull();
  });

  it("templat memuat kolom wajib dan contoh sintetis", () => {
    const rows = parseCsv(importTemplate()) ?? [];
    expect(rows[0]).toEqual(
      expect.arrayContaining(["employee_number", "full_name", "site_code", "job_position_code", "national_id"]),
    );
    expect(rows).toHaveLength(2);
  });
});

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("Impor pekerja (integrasi)", () => {
  let db: Db;
  let issuer: Awaited<ReturnType<typeof makeIssuer>>;
  let app: ReturnType<typeof createApp>;
  const u: Record<string, string> = {};
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  let site1 = "";
  let site2 = "";
  const header =
    "employee_number,full_name,employment_status,join_date,site_code,department_code,job_position_code,contractor_code,national_id";

  const post = async (who: string, body: unknown, key?: string) => {
    const res = await app.request("/api/v1/workers/imports", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await issuer.sign({ sub: u[who] as string })}`,
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    // biome-ignore lint/suspicious/noExplicitAny: bentuk respons diperiksa lewat expect
    return { status: res.status, body: JSON.parse(text) as any, text };
  };

  beforeAll(async () => {
    db = createPool(url);
    issuer = await makeIssuer();
    app = createApp({ db, auth: issuer.verifier, nationalId: createNationalIdCrypto(randomBytes(32), randomBytes(32)) });
    const org = (await db.query<{ id: string }>("select id from organization order by name limit 1")).rows[0]?.id as string;
    for (const who of ["admin", "spv1"]) {
      u[who] = (
        await db.query<{ id: string }>("select id from user_profile where organization_id = $1 and email like $2", [
          org,
          `${who}@%`,
        ])
      ).rows[0]?.id as string;
    }
    // HSE Officer khusus uji ini (uji auth menambah penugasan hseo1 secara paralel), scope Site Supervisor spv1
    const site = (
      await db.query<{ id: string; code: string }>(
        `select s.id, s.code from user_role_assignment ura join site s on s.id = ura.scope_id
         where ura.user_id = $1 and ura.scope_type = 'SITE' and ura.revoked_at is null limit 1`,
        [u.spv1],
      )
    ).rows[0] as { id: string; code: string };
    site1 = site.code;
    u.hseo1 = (
      await db.query<{ id: string }>(
        "insert into user_profile (organization_id, email, full_name, status) values ($1, $2, 'HSE Uji Impor', 'ACTIVE') returning id",
        [org, `hseo-impor-${tag.toLowerCase()}@uji.contoh`],
      )
    ).rows[0]?.id as string;
    await db.query(
      `insert into user_role_assignment (user_id, organization_id, role_code, scope_type, scope_id, granted_by)
       values ($1, $2, 'HSE_OFFICER', 'SITE', $3, $4)`,
      [u.hseo1, org, site.id, u.admin],
    );
    site2 = (
      await db.query<{ code: string }>(
        // Site seed di luar scope hseo1 (uji lain dapat membuat Site baru secara paralel)
        "select code from site where organization_id = $1 and code <> $2 and status = 'ACTIVE' and code like 'SITE-%' order by code limit 1",
        [org, site1],
      )
    ).rows[0]?.code as string;
  });

  afterAll(async () => {
    await db?.end();
  });

  const csv = (lines: string[]) => [header, ...lines].join("\n");

  it("dry_run memvalidasi tanpa menyimpan; galat per baris tanpa nilai sel (NIK tidak bocor)", async () => {
    const nik = `31710${Date.now().toString().slice(-11)}`;
    const body = {
      csv: csv([
        `IMP-${tag}-1,Pekerja Impor Satu,PERMANENT,2026-01-05,${site1},PROD,OPR-AB,,${nik}`,
        `IMP-${tag}-2,Pekerja Impor Dua,CONTRACTOR,2026-01-05,${site1},PROD,OPR-AB,,`,
        `IMP-${tag}-3,X,PERMANENT,2026-01-05,${site1},PROD,OPR-AB,,`,
        `IMP-${tag}-4,Pekerja Impor Empat,PERMANENT,2026-01-05,${site1},TIDAK-ADA,OPR-AB,,`,
        `IMP-${tag}-5,Pekerja Impor Lima,PERMANENT,2026-01-05,${site1},PROD,OPR-AB,,12345`,
      ]),
      dry_run: true,
    };
    const r = await post("admin", body);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: "VALIDATED", total_rows: 5, created: 1, failed: 4, id: null });
    expect(r.body.data.errors).toEqual([
      { row: 3, field: "contractor_code", code: "CONTRACTOR_REQUIRED" },
      { row: 4, field: "full_name", code: "invalid_length" },
      { row: 5, field: "department_code", code: "DEPARTMENT_NOT_IN_SITE" },
      { row: 6, field: "national_id", code: "must_be_16_digits" },
    ]);
    expect(r.text).not.toContain(nik);
    const saved = await db.query("select 1 from worker where employee_number like $1", [`IMP-${tag}-%`]);
    expect(saved.rowCount).toBe(0);
  });

  it("impor sungguhan wajib Idempotency-Key; baris gagal tidak membatalkan baris lain; kunci sama mengembalikan hasil semula", async () => {
    const body = {
      csv: csv([
        `IMP-${tag}-10,Pekerja Impor Sepuluh,PERMANENT,2026-01-05,${site1},PROD,OPR-AB,,`,
        `IMP-${tag}-11,Pekerja Impor Sebelas,CONTRACTOR,2026-01-05,${site1},PROD,OPR-AB,KTR-B,`,
        `IMP-${tag}-10,Pekerja Impor Ganda,PERMANENT,2026-01-05,${site1},PROD,OPR-AB,,`,
      ]),
      dry_run: false,
    };
    expect((await post("admin", body)).status).toBe(422);
    const key = randomUUID();
    const r = await post("admin", body, key);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: "COMPLETED", total_rows: 3, created: 1, failed: 2, replayed: false });
    expect(r.body.data.errors).toEqual([
      { row: 3, field: "site_id", code: "SITE_NOT_LINKED_TO_CONTRACTOR" },
      { row: 4, field: "employee_number", code: "DUPLICATE" },
    ]);
    const w = await db.query<{ sho_id: string }>("select sho_id from worker where employee_number = $1", [`IMP-${tag}-10`]);
    expect(w.rows[0]?.sho_id).toMatch(/^SHO-/);
    const again = await post("admin", body, key);
    expect(again.body.data).toMatchObject({ id: r.body.data.id, created: 1, replayed: true });
    expect((await db.query("select 1 from worker where employee_number = $1", [`IMP-${tag}-10`])).rowCount).toBe(1);
    expect((await post("admin", { ...body, csv: `${body.csv}\nx` }, key)).body.error.code).toBe("IDEMPOTENCY_MISMATCH");
    const audit = await db.query<{ c: Record<string, unknown> }>(
      "select payload->'changes' as c from audit_outbox where payload->>'action' = 'worker.import' and payload->>'entity_id' = $1",
      [r.body.data.id],
    );
    expect(audit.rows[0]?.c).toMatchObject({ created_count: 1, failed_count: 2, status: "COMPLETED" });
  });

  it("all_or_nothing: satu baris gagal membatalkan semua (422 IMPORT_VALIDATION_FAILED)", async () => {
    const body = {
      csv: csv([
        `IMP-${tag}-20,Pekerja Impor Duapuluh,PERMANENT,2026-01-05,${site1},PROD,OPR-AB,,`,
        `IMP-${tag}-21,Pekerja Impor Salah,PERMANENT,2099-01-05,${site1},PROD,OPR-AB,,`,
      ]),
      dry_run: false,
      all_or_nothing: true,
    };
    const r = await post("admin", body, randomUUID());
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("IMPORT_VALIDATION_FAILED");
    expect(r.body.error.result).toMatchObject({ status: "REJECTED", created: 0, failed: 1 });
    expect((await db.query("select 1 from worker where employee_number = $1", [`IMP-${tag}-20`])).rowCount).toBe(0);
  });

  it("scope Site: HSE Officer hanya dapat mengimpor ke Site-nya; tanpa worker.create 403; kolom tak dikenal ditolak", async () => {
    const r = await post("hseo1", {
      csv: csv([
        `IMP-${tag}-30,Pekerja Impor Tigapuluh,PERMANENT,2026-01-05,${site1},PROD,OPR-AB,,`,
        `IMP-${tag}-31,Pekerja Impor Lain,PERMANENT,2026-01-05,${site2},PROD,OPR-AB,,`,
      ]),
      dry_run: true,
    });
    expect(r.body.data).toMatchObject({ created: 1, failed: 1 });
    expect(r.body.data.errors[0]).toEqual({ row: 3, field: "site_code", code: "reference_not_found" });
    expect((await post("spv1", { csv: csv([]), dry_run: true })).status).toBe(403);
    const bad = await post("admin", { csv: "employee_number,nik_asli\nA-1,1", dry_run: true });
    expect(bad.body.error.details[0].issue).toBe("unknown_column:nik_asli");
  });
});

import { createPool, type Db } from "@soh/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/create-app.js";
import { createMemoryStorage } from "../src/storage.js";
import { makeIssuer } from "./jwt-helper.js";

/** Otorisasi Kerja (API-006, SRS-WF005). Bukan Permit To Work. Butuh DATABASE_URL. Data sintetis saja. */

const PDF = Buffer.from("%PDF-1.4\n%otorisasi sintetis\n%%EOF\n");
const url = process.env.DATABASE_URL;

describe.skipIf(!url)("Otorisasi Kerja (integrasi)", () => {
  let db: Db;
  let issuer: Awaited<ReturnType<typeof makeIssuer>>;
  const storage = createMemoryStorage();
  let app: ReturnType<typeof createApp>;
  const u: Record<string, string> = {};
  let org = "";
  let site = "";
  let workerId = "";
  let selfWorkerId = "";
  let heightType = "";
  let hotType = "";
  const tag = Math.random().toString(36).slice(2, 8);

  const call = async (
    who: string,
    path: string,
    method = "GET",
    body?: unknown,
    ifMatch?: number,
    // biome-ignore lint/suspicious/noExplicitAny: bentuk respons diperiksa lewat expect
  ): Promise<{ status: number; body: any }> => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await issuer.sign({ sub: u[who] as string })}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(ifMatch !== undefined ? { "If-Match": `"${ifMatch}"` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json() };
  };
  const one = async (sql: string, params: unknown[] = []) => (await db.query<{ id: string }>(sql, params)).rows[0]?.id as string;
  const today = () => new Date().toISOString().slice(0, 10);
  const plusDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  const cleanFile = async (who: string) => {
    const r = await call(who, "/files", "POST", {
      original_name: "otorisasi-kerja.pdf",
      mime_type: "application/pdf",
      size_bytes: PDF.length,
      purpose: "AUTHORIZATION_DOCUMENT",
    });
    expect(r.status).toBe(201);
    const p = (
      await db.query<{ bucket: string; object_path: string }>("select bucket, object_path from file_object where id = $1", [
        r.body.data.file_id,
      ])
    ).rows[0] as { bucket: string; object_path: string };
    storage.put(p.bucket, p.object_path, PDF);
    expect((await call(who, `/files/${r.body.data.file_id}/complete`, "POST")).body.data.scan_status).toBe("CLEAN");
    return r.body.data.file_id as string;
  };
  const newUser = async (role: string, scopeType: string, scopeId: string | null, name: string) => {
    const id = await one(
      "insert into user_profile (organization_id, email, full_name, status) values ($1, $2, $3, 'ACTIVE') returning id",
      [org, `${name.toLowerCase().replace(/\s/g, "-")}-${tag}@uji.contoh`, name],
    );
    await db.query(
      `insert into user_role_assignment (user_id, organization_id, role_code, scope_type, scope_id, granted_by)
       values ($1, $2, $3, $4, $5, $6)`,
      [id, org, role, scopeType, scopeId, u.admin],
    );
    return id;
  };

  beforeAll(async () => {
    db = createPool(url);
    issuer = await makeIssuer();
    app = createApp({ db, auth: issuer.verifier, storage });
    org = await one("select id from organization order by name limit 1");
    for (const who of ["admin", "hseo1", "pekerja1", "spv1"]) {
      u[who] = await one("select id from user_profile where organization_id = $1 and email like $2", [org, `${who}@%`]);
    }
    site = await one(
      "select scope_id as id from user_role_assignment where user_id = $1 and scope_type = 'SITE' and revoked_at is null limit 1",
      [u.hseo1],
    );
    u.hseo = await newUser("HSE_OFFICER", "SITE", site, "HSE Officer Otorisasi");
    u.mgr = await newUser("HSE_MANAGER", "ORGANIZATION", null, "HSE Manager Otorisasi");
    workerId = await one(
      "select id from worker where site_id = $1 and worker_status = 'ACTIVE' and user_id is null order by sho_id offset 1 limit 1",
      [site],
    );
    selfWorkerId = await one("select id from worker where user_id = $1", [u.pekerja1]);
    heightType = await one("select id from authorization_type where organization_id = $1 and code = 'AUTH-HEIGHT'", [org]);
    hotType = await one("select id from authorization_type where organization_id = $1 and code = 'AUTH-HOTWORK'", [org]);
  });

  afterAll(async () => {
    await db?.end();
  });

  it("master: HSE Manager membuat jenis, HSE Officer tidak; jalur /permits tidak dipakai", async () => {
    const code = `AUTH-U${tag.toUpperCase()}`;
    expect((await call("hseo", "/authorization-types", "POST", { name: "Uji", code })).status).toBe(403);
    const made = await call("mgr", "/authorization-types", "POST", { name: "Otorisasi Uji", code, requires_work_scope: true });
    expect(made.status).toBe(201);
    expect(made.body.data).toMatchObject({ code, requires_work_scope: true });
    expect((await call("hseo", "/authorization-types")).body.data.length).toBeGreaterThan(0);
    expect((await call("mgr", "/permits")).status).toBe(404);
  });

  it("ajukan dengan dokumen -> verifikasi oleh orang lain -> bekukan -> pulihkan -> cabut (akhir)", async () => {
    const fileId = await cleanFile("hseo");
    const r = await call("hseo", `/workers/${workerId}/authorizations`, "POST", {
      authorization_type_id: heightType,
      authorization_number: `KT-${tag}`,
      valid_from: plusDays(-3),
      valid_until: plusDays(700),
      file_id: fileId,
    });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      verification_status: "PENDING",
      suspension_status: "NONE",
      validity_status: "PENDING_VERIFICATION",
      has_document: true,
      can_verify: false,
    });
    const id = r.body.data.id;
    expect((await call("hseo", `/worker-authorizations/${id}/verify`, "POST", {}, 1)).status).toBe(403);
    const v = await call("mgr", `/worker-authorizations/${id}/verify`, "POST", { comment: "Sesuai" }, 1);
    expect(v.body.data).toMatchObject({ verification_status: "VERIFIED", validity_status: "VALID" });

    const docUrl = await call("mgr", `/worker-authorizations/${id}/document-url`);
    expect(docUrl.body.data.expires_in).toBe(300);
    const audit = await db.query<{ n: number }>(
      "select count(*)::int as n from audit_outbox where payload->>'entity_id' = $1 and payload->>'action' = 'authorization.document_access'",
      [id],
    );
    expect(audit.rows[0]?.n).toBe(1);

    // HSE Officer tidak dapat membekukan; HSE Manager wajib alasan
    expect(
      (await call("hseo", `/worker-authorizations/${id}/suspend`, "POST", { reason: "x" }, v.body.data.version)).status,
    ).toBe(403);
    expect((await call("mgr", `/worker-authorizations/${id}/suspend`, "POST", {}, v.body.data.version)).body.error.code).toBe(
      "REASON_REQUIRED",
    );
    const s = await call(
      "mgr",
      `/worker-authorizations/${id}/suspend`,
      "POST",
      { reason: "Investigasi sintetis" },
      v.body.data.version,
    );
    expect(s.body.data).toMatchObject({
      suspension_status: "SUSPENDED",
      validity_status: "SUSPENDED",
      suspended_by_name: "HSE Manager Otorisasi",
    });
    expect(
      (await call("mgr", `/worker-authorizations/${id}/suspend`, "POST", { reason: "lagi" }, s.body.data.version)).body.error
        .code,
    ).toBe("INVALID_STATE_TRANSITION");
    const re = await call("mgr", `/worker-authorizations/${id}/reinstate`, "POST", { reason: "Selesai" }, s.body.data.version);
    expect(re.body.data).toMatchObject({ suspension_status: "NONE", validity_status: "VALID" });
    const rv = await call(
      "mgr",
      `/worker-authorizations/${id}/revoke`,
      "POST",
      { reason: "Pelanggaran sintetis" },
      re.body.data.version,
    );
    expect(rv.body.data.suspension_status).toBe("REVOKED");
    const after = await call("mgr", `/worker-authorizations/${id}/reinstate`, "POST", { reason: "x" }, rv.body.data.version);
    expect(after.body.error.code).toBe("INVALID_STATE_TRANSITION");
    expect(
      (await call("hseo", `/worker-authorizations/${id}`, "PATCH", { valid_until: plusDays(10) }, rv.body.data.version)).body
        .error.code,
    ).toBe("INVALID_STATE_TRANSITION");
  });

  it("lingkup wajib, pengajuan ulang setelah ubah data, pemisahan tugas, rentang tanggal", async () => {
    const noScope = await call("hseo", `/workers/${workerId}/authorizations`, "POST", {
      authorization_type_id: hotType,
      valid_from: today(),
    });
    expect(noScope.body.error.code).toBe("WORK_SCOPE_REQUIRED");
    const bad = await call("hseo", `/workers/${workerId}/authorizations`, "POST", {
      authorization_type_id: heightType,
      valid_from: today(),
      valid_until: plusDays(-1),
    });
    expect(bad.body.error.code).toBe("INVALID_DATE_RANGE");
    const own = await call("mgr", `/workers/${workerId}/authorizations`, "POST", {
      authorization_type_id: hotType,
      valid_from: today(),
      work_scope: "Pengelasan pipa",
    });
    expect(own.status).toBe(201);
    expect((await call("mgr", `/worker-authorizations/${own.body.data.id}/verify`, "POST", {}, 1)).body.error.code).toBe(
      "SEPARATION_OF_DUTIES",
    );
    const q = await call("mgr", `/authorizations/pending-verification?site_id=${site}&limit=200`);
    expect(q.body.data.find((x: { id: string }) => x.id === own.body.data.id)?.can_verify).toBe(false);

    const h = await call("hseo", `/workers/${workerId}/authorizations`, "POST", {
      authorization_type_id: heightType,
      valid_from: today(),
    });
    const v = await call("mgr", `/worker-authorizations/${h.body.data.id}/verify`, "POST", {}, 1);
    const p = await call(
      "hseo",
      `/worker-authorizations/${h.body.data.id}`,
      "PATCH",
      { restriction_note: "Hanya siang hari" },
      v.body.data.version,
    );
    expect(p.body.data).toMatchObject({ verification_status: "PENDING", restriction_note: "Hanya siang hari" });
    expect((await call("hseo", `/worker-authorizations/${h.body.data.id}`, "PATCH", { work_scope: "x" }, 1)).status).toBe(412);
  });

  it("pekerja (SELF) mengajukan miliknya, tidak milik orang lain; tidak membekukan", async () => {
    const lst = await call("pekerja1", "/authorization-types");
    expect(lst.status).toBe(200);
    const mine = await call("pekerja1", `/workers/${selfWorkerId}/authorizations`, "POST", {
      authorization_type_id: heightType,
      valid_from: today(),
    });
    expect(mine.status).toBe(201);
    expect((await call("pekerja1", `/workers/${selfWorkerId}/authorizations`)).body.data.length).toBeGreaterThan(0);
    expect((await call("pekerja1", `/workers/${workerId}/authorizations`)).status).toBe(404);
    expect(
      (await call("pekerja1", `/worker-authorizations/${mine.body.data.id}/suspend`, "POST", { reason: "x" }, 1)).status,
    ).toBe(403);
    expect(
      (
        await call("spv1", `/workers/${workerId}/authorizations`, "POST", {
          authorization_type_id: heightType,
          valid_from: today(),
        })
      ).status,
    ).toBe(403);
  });
});

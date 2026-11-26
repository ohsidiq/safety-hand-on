import { createPool, type Db } from "@soh/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/create-app.js";
import { createMemoryStorage } from "../src/storage.js";
import { makeIssuer } from "./jwt-helper.js";

/** SIMPER dan otorisasi per kelas alat (API-007, SRS-WF006). Butuh DATABASE_URL. Data sintetis saja. */

const PDF = Buffer.from("%PDF-1.4\n%simper sintetis\n%%EOF\n");
const url = process.env.DATABASE_URL;

describe.skipIf(!url)("SIMPER (integrasi)", () => {
  let db: Db;
  let issuer: Awaited<ReturnType<typeof makeIssuer>>;
  const storage = createMemoryStorage();
  let app: ReturnType<typeof createApp>;
  const u: Record<string, string> = {};
  let org = "";
  let site = "";
  let workerId = "";
  let selfWorkerId = "";
  let prodType = "";
  const cls: Record<string, string> = {};
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
  const plusDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  const cleanFile = async (who: string) => {
    const r = await call(who, "/files", "POST", {
      original_name: "simper.pdf",
      mime_type: "application/pdf",
      size_bytes: PDF.length,
      purpose: "SIMPER_DOCUMENT",
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
    u.hseo = await newUser("HSE_OFFICER", "SITE", site, "HSE Officer SIMPER");
    u.mgr = await newUser("HSE_MANAGER", "ORGANIZATION", null, "HSE Manager SIMPER");
    workerId = await one(
      "select id from worker where site_id = $1 and worker_status = 'ACTIVE' and user_id is null order by sho_id offset 2 limit 1",
      [site],
    );
    selfWorkerId = await one("select id from worker where user_id = $1", [u.pekerja1]);
    prodType = await one("select id from simper_type where organization_id = $1 and code = 'SIMPER-PROD'", [org]);
    for (const code of ["DT", "EXC", "LV"]) {
      cls[code] = await one("select id from equipment_class where organization_id = $1 and code = $2", [org, code]);
    }
  });

  afterAll(async () => {
    await db?.end();
  });

  it("master: HSE Manager membuat jenis SIMPER, HSE Officer tidak", async () => {
    const code = `SIMPER-U${tag.toUpperCase()}`;
    expect((await call("hseo", "/simper-types", "POST", { name: "Uji", code })).status).toBe(403);
    const made = await call("mgr", "/simper-types", "POST", { name: "SIMPER Uji", code, default_validity_months: 12 });
    expect(made.status).toBe(201);
    expect((await call("hseo", "/simper-types")).body.data.length).toBeGreaterThan(0);
  });

  it("ajukan SIMPER + kelas alat -> verifikasi orang lain -> tambah kelas -> PENDING lagi; dokumen teraudit", async () => {
    // minimal satu otorisasi kelas alat (VR-WF006-006)
    const none = await call("hseo", `/workers/${workerId}/simpers`, "POST", {
      simper_type_id: prodType,
      valid_from: plusDays(-5),
      authorizations: [],
    });
    expect(none.status).toBe(422);
    const outside = await call("hseo", `/workers/${workerId}/simpers`, "POST", {
      simper_type_id: prodType,
      valid_from: plusDays(-5),
      valid_until: plusDays(300),
      authorizations: [{ equipment_class_id: cls.DT, valid_from: plusDays(-5), valid_until: plusDays(400) }],
    });
    expect(outside.body.error.code).toBe("AUTHORIZATION_OUTSIDE_SIMPER_VALIDITY");

    const fileId = await cleanFile("hseo");
    const r = await call("hseo", `/workers/${workerId}/simpers`, "POST", {
      simper_type_id: prodType,
      simper_number: `SMP-${tag}`,
      valid_from: plusDays(-5),
      valid_until: plusDays(300),
      file_id: fileId,
      authorizations: [{ equipment_class_id: cls.DT, valid_from: plusDays(-5), valid_until: plusDays(300) }],
    });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ verification_status: "PENDING", has_document: true });
    expect(r.body.data.equipment_authorizations).toHaveLength(1);
    expect(r.body.data.equipment_authorizations[0].equipment_class.code).toBe("DT");
    const id = r.body.data.id;

    expect((await call("hseo", `/simpers/${id}/verify`, "POST", {}, 1)).status).toBe(403);
    const v = await call("mgr", `/simpers/${id}/verify`, "POST", {}, 1);
    expect(v.body.data).toMatchObject({ verification_status: "VERIFIED", validity_status: "VALID" });
    expect((await call("mgr", `/simpers/${id}/document-url`)).body.data.expires_in).toBe(300);

    // kelas ganda ditolak; kelas baru mengembalikan SIMPER ke PENDING
    const dup = await call("hseo", `/simpers/${id}/authorizations`, "POST", {
      equipment_class_id: cls.DT,
      valid_from: plusDays(-5),
      valid_until: plusDays(100),
    });
    expect(dup.body.error.code).toBe("DUPLICATE");
    const exc = await call("hseo", `/simpers/${id}/authorizations`, "POST", {
      equipment_class_id: cls.EXC,
      valid_from: plusDays(-5),
      valid_until: plusDays(200),
      restriction_note: "Hanya siang hari",
    });
    expect(exc.status).toBe(201);
    expect((await call("hseo", `/simpers/${id}`)).body.data.verification_status).toBe("PENDING");

    // status kelas alat: HSE Officer ditolak; HSE Manager bekukan -> pulihkan -> cabut (akhir)
    expect((await call("hseo", `/simper-authorizations/${exc.body.data.id}/suspend`, "POST", { reason: "x" }, 1)).status).toBe(
      403,
    );
    const s = await call("mgr", `/simper-authorizations/${exc.body.data.id}/suspend`, "POST", { reason: "Insiden sintetis" }, 1);
    expect(s.body.data.status).toBe("SUSPENDED");
    const re = await call(
      "mgr",
      `/simper-authorizations/${exc.body.data.id}/reinstate`,
      "POST",
      { reason: "Selesai" },
      s.body.data.version,
    );
    expect(re.body.data.status).toBe("ACTIVE");
    const rv = await call(
      "mgr",
      `/simper-authorizations/${exc.body.data.id}/revoke`,
      "POST",
      { reason: "Dicabut" },
      re.body.data.version,
    );
    expect(rv.body.data.status).toBe("REVOKED");
    const p = await call(
      "hseo",
      `/simper-authorizations/${exc.body.data.id}`,
      "PATCH",
      { restriction_note: "x" },
      rv.body.data.version,
    );
    expect(p.body.error.code).toBe("INVALID_STATE_TRANSITION");

    // mempersempit SIMPER melewati otorisasi aktif ditolak
    const cur = (await call("hseo", `/simpers/${id}`)).body.data;
    const narrow = await call("hseo", `/simpers/${id}`, "PATCH", { valid_until: plusDays(50) }, cur.version);
    expect(narrow.body.error.code).toBe("AUTHORIZATION_OUTSIDE_SIMPER_VALIDITY");
  });

  it("pembekuan SIMPER oleh HSE Manager; dicabut = akhir", async () => {
    const r = await call("hseo", `/workers/${workerId}/simpers`, "POST", {
      simper_type_id: prodType,
      valid_from: plusDays(-1),
      valid_until: plusDays(100),
      authorizations: [{ equipment_class_id: cls.LV, valid_from: plusDays(-1), valid_until: plusDays(100) }],
    });
    const id = r.body.data.id;
    const v = await call("mgr", `/simpers/${id}/verify`, "POST", {}, 1);
    expect((await call("hseo", `/simpers/${id}/suspend`, "POST", { reason: "x" }, v.body.data.version)).status).toBe(403);
    const s = await call("mgr", `/simpers/${id}/suspend`, "POST", { reason: "Pemeriksaan sintetis" }, v.body.data.version);
    expect(s.body.data).toMatchObject({ suspension_status: "SUSPENDED", validity_status: "SUSPENDED" });
    const rv = await call("mgr", `/simpers/${id}/revoke`, "POST", { reason: "Pelanggaran sintetis" }, s.body.data.version);
    expect(rv.body.data.suspension_status).toBe("REVOKED");
    const add = await call("hseo", `/simpers/${id}/authorizations`, "POST", {
      equipment_class_id: cls.DT,
      valid_from: plusDays(-1),
      valid_until: plusDays(50),
    });
    expect(add.body.error.code).toBe("INVALID_STATE_TRANSITION");
  });

  it("pekerja (SELF) mengajukan SIMPER-nya, tidak milik orang lain; Supervisor tidak mencatat", async () => {
    expect((await call("pekerja1", "/simper-types")).status).toBe(200);
    const mine = await call("pekerja1", `/workers/${selfWorkerId}/simpers`, "POST", {
      simper_type_id: prodType,
      valid_from: plusDays(-1),
      authorizations: [{ equipment_class_id: cls.LV, valid_from: plusDays(-1) }],
    });
    expect(mine.status).toBe(201);
    expect((await call("pekerja1", `/workers/${workerId}/simpers`)).status).toBe(404);
    expect((await call("pekerja1", `/simpers/${mine.body.data.id}/verify`, "POST", {}, 1)).status).toBe(403);
    expect((await call("pekerja1", "/simpers/pending-verification")).status).toBe(403);
    expect(
      (
        await call("spv1", `/workers/${workerId}/simpers`, "POST", {
          simper_type_id: prodType,
          valid_from: plusDays(-1),
          authorizations: [{ equipment_class_id: cls.LV, valid_from: plusDays(-1) }],
        })
      ).status,
    ).toBe(403);
  });
});

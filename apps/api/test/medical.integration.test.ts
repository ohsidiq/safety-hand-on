import { createPool, type Db } from "@soh/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/create-app.js";
import { createMemoryStorage } from "../src/storage.js";
import { makeIssuer } from "./jwt-helper.js";

/** Medical (API-005 v2.1, SRS-WF004 v1.4, B-27 Dokter). Data SINTETIS saja (B-24): tanpa diagnosis. Butuh DATABASE_URL. */

const PDF = Buffer.from("%PDF-1.4\n%mcu sintetis\n%%EOF\n");
const url = process.env.DATABASE_URL;
const REASON = "Penetapan MCU berkala sintetis";

describe.skipIf(!url)("Medical (integrasi)", () => {
  let db: Db;
  let issuer: Awaited<ReturnType<typeof makeIssuer>>;
  const storage = createMemoryStorage();
  let app: ReturnType<typeof createApp>;
  const u: Record<string, string> = {};
  let org = "";
  let site = "";
  let teamWorker = "";
  let selfWorkerId = "";
  let examType = "";
  const tag = Math.random().toString(36).slice(2, 8);

  const call = async (
    who: string,
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
    // biome-ignore lint/suspicious/noExplicitAny: bentuk respons diperiksa lewat expect
  ): Promise<{ status: number; body: any; headers: Headers }> => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await issuer.sign({ sub: u[who] as string })}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  const one = async (sql: string, params: unknown[] = []) => (await db.query<{ id: string }>(sql, params)).rows[0]?.id as string;
  const plusDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
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
    for (const who of ["admin", "hseo1", "pekerja1", "spvtim1"]) {
      u[who] = await one("select id from user_profile where organization_id = $1 and email like $2", [org, `${who}@%`]);
    }
    site = await one(
      "select scope_id as id from user_role_assignment where user_id = $1 and scope_type = 'SITE' and revoked_at is null limit 1",
      [u.hseo1],
    );
    u.hseo = await newUser("HSE_OFFICER", "SITE", site, "HSE Officer Medis");
    u.mgr = await newUser("HSE_MANAGER", "ORGANIZATION", null, "HSE Manager Medis");
    u.mo = await newUser("MEDICAL_OFFICER", "ORGANIZATION", null, "Medical Officer Uji");
    u.doc = await newUser("DOCTOR", "ORGANIZATION", null, "Dokter Uji");
    selfWorkerId = await one("select id from worker where user_id = $1", [u.pekerja1]);
    teamWorker = await one(
      `select tm.worker_id as id from user_role_assignment ura join team_member tm on tm.team_id = ura.scope_id
        where ura.user_id = $1 and ura.scope_type = 'TEAM' and ura.revoked_at is null and tm.worker_id <> $2
          and (tm.valid_until is null or tm.valid_until >= current_date) order by tm.worker_id limit 1`,
      [u.spvtim1, selfWorkerId],
    );
    u.hseoSelf = await newUser(
      "HSE_OFFICER",
      "SITE",
      await one("select site_id as id from worker where id = $1", [selfWorkerId]),
      "HSE Officer Site Pekerja",
    );
    examType = await one("select id from medical_exam_type where organization_id = $1 and code = 'MCU-PERIODIC'", [org]);
  });

  afterAll(async () => {
    await db?.end();
  });

  it("pencatatan administratif -> penetapan Dokter -> status untuk Supervisor tanpa detail", async () => {
    // HSE Officer (medical.update LIMITED) mengunggah dokumen MCU ke bucket terbatas dan mencatat
    const up = await call("hseo", "/files", "POST", {
      original_name: "mcu.pdf",
      mime_type: "application/pdf",
      size_bytes: PDF.length,
      purpose: "MEDICAL_DOCUMENT",
    });
    expect(up.status).toBe(201);
    const p = (
      await db.query<{ bucket: string; object_path: string }>("select bucket, object_path from file_object where id = $1", [
        up.body.data.file_id,
      ])
    ).rows[0] as { bucket: string; object_path: string };
    expect(p.bucket).toBe("soh-medical");
    storage.put(p.bucket, p.object_path, PDF);
    expect((await call("hseo", `/files/${up.body.data.file_id}/complete`, "POST")).body.data.scan_status).toBe("CLEAN");

    const rec = await call("hseo", `/workers/${teamWorker}/medical-records`, "POST", {
      exam_type_id: examType,
      examination_date: plusDays(-1),
      expiry_date: plusDays(364),
      provider: "Klinik Sintetis",
      file_id: up.body.data.file_id,
    });
    expect(rec.status).toBe(201);
    expect(rec.body.data).toMatchObject({ verification_status: "PENDING", fitness_status: null, has_document: true });
    const id = rec.body.data.id;

    // HSE Officer dan Medical Officer (petugas medis) tidak dapat menetapkan; Dokter wajib pembatasan untuk
    // FIT_WITH_RESTRICTION dan tindak lanjut untuk FIT_WITH_CONDITION
    expect(
      (await call("hseo", `/medical-records/${id}/determination`, "POST", { fitness_status: "FIT" }, { "If-Match": '"1"' }))
        .status,
    ).toBe(403);
    expect(
      (await call("mo", `/medical-records/${id}/determination`, "POST", { fitness_status: "FIT" }, { "If-Match": '"1"' })).status,
    ).toBe(403);
    const noR = await call(
      "doc",
      `/medical-records/${id}/determination`,
      "POST",
      { fitness_status: "FIT_WITH_RESTRICTION" },
      { "If-Match": '"1"' },
    );
    expect(noR.body.error.code).toBe("RESTRICTION_REQUIRED");
    const noF = await call(
      "doc",
      `/medical-records/${id}/determination`,
      "POST",
      { fitness_status: "FIT_WITH_CONDITION", follow_up_note: "Kontrol tensi ulang" },
      { "If-Match": '"1"' },
    );
    expect(noF.body.error.code).toBe("FOLLOW_UP_REQUIRED");
    const badU = await call(
      "doc",
      `/medical-records/${id}/determination`,
      "POST",
      { fitness_status: "FIT", unfit_until: plusDays(10) },
      { "If-Match": '"1"' },
    );
    expect(badU.body.error.code).toBe("VALIDATION_ERROR");
    expect((await call("mo", "/medical-records/pending-determination")).status).toBe(403);
    const queue = await call("doc", `/medical-records/pending-determination?site_id=${site}&limit=200`);
    expect(queue.body.data.some((x: { id: string }) => x.id === id)).toBe(true);
    const det = await call(
      "doc",
      `/medical-records/${id}/determination`,
      "POST",
      {
        fitness_status: "FIT_WITH_RESTRICTION",
        restrictions: [
          {
            restriction_code: "NO_WORK_AT_HEIGHT",
            operational_description: "Tidak bekerja di ketinggian di atas 2 meter",
            valid_from: plusDays(-1),
            valid_until: plusDays(180),
          },
        ],
        comment: "Evaluasi ulang sintetis",
      },
      { "If-Match": '"1"' },
    );
    expect(det.status).toBe(200);
    expect(det.body.data).toMatchObject({ verification_status: "VERIFIED", fitness_status: "FIT_WITH_RESTRICTION" });

    // Supervisor Tim: status + pembatasan operasional, tanpa dokumen/penyedia/jenis; detail ditolak
    const st = await call("spvtim1", `/workers/${teamWorker}/medical-status`);
    expect(st.status).toBe(200);
    expect(st.body.data).toMatchObject({ fitness_status: "FIT_WITH_RESTRICTION", validity_status: "VALID" });
    expect(st.body.data.restrictions[0].restriction_code).toBe("NO_WORK_AT_HEIGHT");
    expect(JSON.stringify(st.body.data)).not.toMatch(/provider|Klinik|file_id|exam_type|comment/);
    expect(
      (await call("spvtim1", `/workers/${teamWorker}/medical-records`, "GET", undefined, { "X-Access-Reason": REASON })).status,
    ).toBe(403);
    expect((await call("spvtim1", `/workers/${teamWorker}/medical-restrictions`)).body.data).toHaveLength(1);

    // Medical Officer membaca detail: alasan wajib dan teraudit sensitif; dokumen 60 detik
    expect((await call("mo", `/medical-records/${id}`)).body.error.code).toBe("ACCESS_REASON_REQUIRED");
    const d = await call("mo", `/medical-records/${id}`, "GET", undefined, { "X-Access-Reason": REASON });
    expect(d.status).toBe(200);
    expect(d.headers.get("cache-control")).toBe("no-store");
    const docUrl = await call("mo", `/medical-records/${id}/document-url`, "GET", undefined, { "X-Access-Reason": REASON });
    expect(docUrl.body.data.expires_in).toBe(60);
    const audit = await db.query<{ action: string; sensitive: boolean; reason: string | null }>(
      `select payload->>'action' as action, (payload->>'sensitive_access')::boolean as sensitive, payload->>'access_reason' as reason
         from audit_outbox where payload->>'entity_id' = $1 and payload->>'action' in ('medical.read_detail', 'medical.document_access')`,
      [id],
    );
    expect(audit.rows.length).toBe(2);
    expect(audit.rows.every((r) => r.sensitive && r.reason === REASON)).toBe(true);

    // HSE Manager: tanpa otorisasi ditolak; dengan otorisasi Dokter terbuka; dicabut tertutup lagi
    expect((await call("mgr", `/medical-records/${id}`, "GET", undefined, { "X-Access-Reason": REASON })).status).toBe(404);
    const gr = await call("doc", "/medical-access-grantees");
    expect(gr.body.data.some((x: { id: string }) => x.id === u.mgr)).toBe(true);
    const g = await call("doc", `/medical-records/${id}/access-grants`, "POST", {
      grantee_user_id: u.mgr,
      reason: "Investigasi insiden sintetis",
      hours: 2,
    });
    expect(g.status).toBe(201);
    expect((await call("mgr", `/medical-records/${id}`, "GET", undefined, { "X-Access-Reason": REASON })).status).toBe(200);
    expect((await call("doc", `/medical-access-grants/${g.body.data.id}/revoke`, "POST")).body.data.active).toBe(false);
    expect((await call("mgr", `/medical-records/${id}`, "GET", undefined, { "X-Access-Reason": REASON })).status).toBe(404);
    const bad = await call("doc", `/medical-records/${id}/access-grants`, "POST", {
      grantee_user_id: u.spvtim1,
      reason: "Bukan HSE Manager sintetis",
      hours: 1,
    });
    expect(bad.body.error.code).toBe("GRANTEE_NOT_ELIGIBLE");

    // ubah data administratif -> PENDING, Fit to Work dan pembatasan dikosongkan
    const lift = await call("mo", `/medical-records/${id}`, "GET", undefined, { "X-Access-Reason": REASON });
    const patched = await call(
      "hseo",
      `/medical-records/${id}`,
      "PATCH",
      { provider: "Klinik Sintetis Dua" },
      { "If-Match": `"${lift.body.data.version}"` },
    );
    expect(patched.status).toBe(404); // pencatat tidak lagi melihat record yang sudah ditetapkan
    const p2 = await call(
      "mo",
      `/medical-records/${id}`,
      "PATCH",
      { provider: "Klinik Sintetis Dua" },
      { "If-Match": `"${lift.body.data.version}"` },
    );
    expect(p2.body.data).toMatchObject({ verification_status: "PENDING", fitness_status: null });
    expect(p2.body.data.restrictions[0].status).toBe("LIFTED");
  });

  it("pemisahan tugas, penolakan beralasan, pekerja melihat miliknya tanpa alasan", async () => {
    const own = await call("doc", `/workers/${teamWorker}/medical-records`, "POST", {
      exam_type_id: examType,
      examination_date: plusDays(-1),
      expiry_date: plusDays(300),
    });
    expect(own.body).toMatchObject({ success: true });
    const sod = await call(
      "doc",
      `/medical-records/${own.body.data.id}/determination`,
      "POST",
      { fitness_status: "FIT" },
      { "If-Match": '"1"' },
    );
    expect(sod.body.error.code).toBe("SEPARATION_OF_DUTIES");

    const rec = await call("hseoSelf", `/workers/${selfWorkerId}/medical-records`, "POST", {
      exam_type_id: examType,
      examination_date: plusDays(-2),
      expiry_date: plusDays(300),
    });
    expect(
      (await call("doc", `/medical-records/${rec.body.data.id}/reject`, "POST", {}, { "If-Match": '"1"' })).body.error.code,
    ).toBe("REASON_REQUIRED");
    const rj = await call(
      "doc",
      `/medical-records/${rec.body.data.id}/reject`,
      "POST",
      { reason: "Dokumen tidak terbaca" },
      { "If-Match": '"1"' },
    );
    expect(rj.body.data.verification_status).toBe("REJECTED");

    // pekerja sendiri: status dan detail miliknya tanpa alasan, bukan milik orang lain
    expect((await call("pekerja1", `/workers/${selfWorkerId}/medical-status`)).status).toBe(200);
    const mine = await call("pekerja1", `/workers/${selfWorkerId}/medical-records`);
    expect(mine.status).toBe(200);
    expect(mine.body.data.some((x: { id: string }) => x.id === rec.body.data.id)).toBe(true);
    expect((await call("pekerja1", `/workers/${teamWorker}/medical-status`)).status).toBe(404);
    expect((await call("pekerja1", "/medical-records/pending-determination")).status).toBe(403);
    expect(
      (
        await call("pekerja1", `/workers/${selfWorkerId}/medical-records`, "POST", {
          exam_type_id: examType,
          examination_date: plusDays(-1),
          expiry_date: plusDays(10),
        })
      ).status,
    ).toBe(403);
  });
});

import { createPool, type Db } from "@soh/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/create-app.js";
import { makeIssuer } from "./jwt-helper.js";

/**
 * Peran Dokter dan pemeriksaan kesiapan kerja khusus (B-27, API-005 v2.1 bagian 5a). Data SINTETIS saja (B-24): tanpa angka tanda
 * vital, tanpa diagnosis. Butuh DATABASE_URL.
 */

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("Dokter dan kesiapan kerja khusus (integrasi)", () => {
  let db: Db;
  let issuer: Awaited<ReturnType<typeof makeIssuer>>;
  let app: ReturnType<typeof createApp>;
  const u: Record<string, string> = {};
  let org = "";
  let site = "";
  let worker = "";
  let restrictedWorker = "";
  let examType = "";
  let heightType = "";
  const tag = Math.random().toString(36).slice(2, 8);

  const call = async (
    who: string,
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
    // biome-ignore lint/suspicious/noExplicitAny: bentuk respons diperiksa lewat expect
  ): Promise<{ status: number; body: any }> => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await issuer.sign({ sub: u[who] as string })}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json() };
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
  const checklist = {
    history_reviewed: true,
    blood_pressure_checked: true,
    vital_signs_checked: true,
    vitals_within_limits: true,
  };

  beforeAll(async () => {
    db = createPool(url);
    issuer = await makeIssuer();
    app = createApp({ db, auth: issuer.verifier });
    org = await one("select id from organization order by name limit 1");
    for (const who of ["admin", "hsemgr", "hseo1", "spv1"]) {
      u[who] = await one("select id from user_profile where organization_id = $1 and email like $2", [org, `${who}@%`]);
    }
    site = await one(
      "select scope_id as id from user_role_assignment where user_id = $1 and scope_type = 'SITE' and revoked_at is null limit 1",
      [u.hseo1],
    );
    u.mo = await newUser("MEDICAL_OFFICER", "SITE", site, "Petugas Medis Kesiapan");
    u.doc = await newUser("DOCTOR", "SITE", site, "Dokter Kesiapan");
    examType = await one("select id from medical_exam_type where organization_id = $1 and code = 'MCU-PERIODIC'", [org]);
    heightType = await one("select id from medical_clearance_type where organization_id = $1 and code = 'WORK-AT-HEIGHT'", [org]);
    // pekerja FIT tanpa pembatasan dan tanpa pemeriksaan kesiapan (MCU baru di uji menjadi yang terbaru)
    worker = await one(
      `select w.id from worker w where w.site_id = $1 and w.worker_status = 'ACTIVE' and w.user_id is null
          and not exists (select 1 from medical_record m where m.worker_id = w.id and m.fitness_status is distinct from 'FIT')
          and not exists (select 1 from medical_clearance x where x.worker_id = w.id) order by w.id desc limit 1`,
      [site],
    );
    restrictedWorker = await one(
      `select m.worker_id as id from medical_record m join medical_restriction r on r.medical_record_id = m.id
        where m.site_id = $1 and r.status = 'ACTIVE' and r.restriction_code = 'NO_WORK_AT_HEIGHT'
          and (r.valid_until is null or r.valid_until >= current_date) and m.expiry_date >= current_date limit 1`,
      [site],
    );
  });

  afterAll(async () => {
    await db?.end();
  });

  it("jenis kerja khusus: tambah, ubah (If-Match), nonaktifkan, aktifkan kembali", async () => {
    const code = `UJI-${tag.toUpperCase()}`;
    const made = await call("hsemgr", "/medical-clearance-types", "POST", { name: "test", code });
    expect(made.status).toBe(201);
    expect(made.body.data).toMatchObject({ validity_hours: 12, blocking_restriction_codes: [], version: 1 });
    const id = made.body.data.id;
    expect((await call("doc", `/medical-clearance-types/${id}`, "PATCH", { name: "x y" }, { "If-Match": '"1"' })).status).toBe(
      403,
    );
    const stale = await call("hsemgr", `/medical-clearance-types/${id}`, "PATCH", { name: "Lama" }, { "If-Match": '"9"' });
    expect(stale.status).toBe(412);
    const upd = await call(
      "hsemgr",
      `/medical-clearance-types/${id}`,
      "PATCH",
      { name: "Angkat Beban Uji", validity_hours: 8, blocking_restriction_codes: ["NO_HEAVY_LIFTING"] },
      { "If-Match": '"1"' },
    );
    expect(upd.status).toBe(200);
    expect(upd.body.data).toMatchObject({
      name: "Angkat Beban Uji",
      validity_hours: 8,
      blocking_restriction_codes: ["NO_HEAVY_LIFTING"],
      version: 2,
    });
    expect(
      (await call("hsemgr", `/medical-clearance-types/${id}`, "PATCH", { validity_hours: 30 }, { "If-Match": '"2"' })).status,
    ).toBe(422);
    const off = await call("hsemgr", `/medical-clearance-types/${id}/deactivate`, "POST", undefined, { "If-Match": '"2"' });
    expect(off.body.data).toMatchObject({ status: "INACTIVE", version: 3 });
    const on = await call("hsemgr", `/medical-clearance-types/${id}/reactivate`, "POST", undefined, { "If-Match": '"3"' });
    expect(on.body.data).toMatchObject({ status: "ACTIVE", version: 4 });
  });

  it("Dokter menetapkan Fit dengan kondisi; status menampilkan tanggal tindak lanjut tanpa catatan", async () => {
    const rec = await call("mo", `/workers/${worker}/medical-records`, "POST", {
      exam_type_id: examType,
      examination_date: plusDays(-1),
      expiry_date: plusDays(364),
    });
    expect(rec.status).toBe(201);
    const det = await call(
      "doc",
      `/medical-records/${rec.body.data.id}/determination`,
      "POST",
      { fitness_status: "FIT_WITH_CONDITION", follow_up_note: "Kontrol ulang di klinik site", follow_up_due: plusDays(14) },
      { "If-Match": '"1"' },
    );
    expect(det.status).toBe(200);
    expect(det.body.data).toMatchObject({ fitness_status: "FIT_WITH_CONDITION", follow_up_due: plusDays(14) });
    const st = await call("spv1", `/workers/${worker}/medical-status`);
    expect(st.body.data).toMatchObject({
      fitness_status: "FIT_WITH_CONDITION",
      validity_status: "VALID",
      follow_up_due: plusDays(14),
    });
    expect(JSON.stringify(st.body)).not.toContain("Kontrol ulang");
  });

  it("pemeriksaan kesiapan: hanya Dokter, checklist lengkap, satu shift, menolak MCU tidak berlaku dan pembatasan", async () => {
    const types = await call("doc", "/medical-clearance-types");
    expect(types.body.data.find((t: { id: string }) => t.id === heightType)).toMatchObject({
      validity_hours: 12,
      blocking_restriction_codes: ["NO_WORK_AT_HEIGHT"],
    });
    const body = { clearance_type_id: heightType, result: "CLEARED", ...checklist };
    expect((await call("mo", `/workers/${worker}/medical-clearances`, "POST", body)).status).toBe(403);
    expect((await call("hseo1", `/workers/${worker}/medical-clearances`, "POST", body)).status).toBe(403);
    const inc = await call("doc", `/workers/${worker}/medical-clearances`, "POST", { ...body, blood_pressure_checked: false });
    expect(inc.status).toBe(422);
    expect(inc.body.error.code).toBe("CHECKLIST_INCOMPLETE");
    // angka tanda vital ditolak (skema ketat)
    expect((await call("doc", `/workers/${worker}/medical-clearances`, "POST", { ...body, systolic: 120 })).status).toBe(422);
    const noNote = await call("doc", `/workers/${worker}/medical-clearances`, "POST", { ...body, result: "NOT_CLEARED" });
    expect(noNote.body.error.code).toBe("REASON_REQUIRED");
    const conflict = await call("doc", `/workers/${restrictedWorker}/medical-clearances`, "POST", body);
    expect(conflict.body.error.code).toBe("RESTRICTION_CONFLICT");

    const ok = await call("doc", `/workers/${worker}/medical-clearances`, "POST", body);
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ result: "CLEARED", active: true, type_code: "WORK-AT-HEIGHT" });
    const hours = (Date.parse(ok.body.data.valid_until) - Date.parse(ok.body.data.examined_at)) / 3600000;
    expect(Math.round(hours)).toBe(12);

    // Supervisor Site melihat hasil tanpa checklist
    const seen = await call("spv1", `/workers/${worker}/medical-clearances`);
    expect(seen.status).toBe(200);
    expect(seen.body.data[0]).toMatchObject({ id: ok.body.data.id, active: true });
    expect(seen.body.data[0].vitals_within_limits).toBeUndefined();

    // pencabutan: alasan wajib, hanya Dokter, sekali
    expect((await call("doc", `/medical-clearances/${ok.body.data.id}/revoke`, "POST", {})).body.error.code).toBe(
      "REASON_REQUIRED",
    );
    expect((await call("mo", `/medical-clearances/${ok.body.data.id}/revoke`, "POST", { reason: "x" })).status).toBe(403);
    const rv = await call("doc", `/medical-clearances/${ok.body.data.id}/revoke`, "POST", { reason: "Keluhan baru sintetis" });
    expect(rv.status).toBe(200);
    expect((await call("doc", `/medical-clearances/${ok.body.data.id}/revoke`, "POST", { reason: "Lagi" })).body.error.code).toBe(
      "INVALID_STATE_TRANSITION",
    );
    expect(
      (await call("spv1", `/workers/${worker}/medical-clearances`)).body.data.some(
        (x: { id: string }) => x.id === ok.body.data.id,
      ),
    ).toBe(false);

    // MCU UNFIT -> SIAP ditolak
    const rec2 = await call("mo", `/workers/${worker}/medical-records`, "POST", {
      exam_type_id: examType,
      examination_date: plusDays(0),
      expiry_date: plusDays(365),
    });
    await call(
      "doc",
      `/medical-records/${rec2.body.data.id}/determination`,
      "POST",
      { fitness_status: "UNFIT", unfit_until: plusDays(30) },
      { "If-Match": '"1"' },
    );
    const unfit = await call("doc", `/workers/${worker}/medical-clearances`, "POST", body);
    expect(unfit.body.error.code).toBe("MCU_NOT_VALID");
  });
});

import { createPool, type Db } from "@soh/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/create-app.js";
import { validateProfileItems } from "../src/readiness.js";
import { makeIssuer } from "./jwt-helper.js";

/** Readiness API M4.2 (API-014 bagian 2, 3, 5, 6; B-30). Data SINTETIS saja (B-24). Butuh DATABASE_URL. */

describe("validasi syarat profile (unit)", () => {
  const cmp = "00000000-0000-4000-8000-000000000001";
  const mcu = "00000000-0000-4000-8000-000000000002";
  const base = { is_mandatory: true, warning_days: 30 };
  it("menolak TRAINING, rujukan ganda, kelas alat di luar SIMPER, dan syarat ganda", () => {
    expect(validateProfileItems([{ ...base, item_type: "TRAINING" }])?.code).toBe("ITEM_TYPE_NOT_AVAILABLE");
    expect(
      validateProfileItems([{ ...base, item_type: "COMPETENCY", competency_id: cmp, medical_exam_type_id: mcu }])?.code,
    ).toBe("INVALID_REQUIREMENT_REFERENCE");
    expect(validateProfileItems([{ ...base, item_type: "MEDICAL", competency_id: cmp }])?.code).toBe(
      "INVALID_REQUIREMENT_REFERENCE",
    );
    expect(validateProfileItems([{ ...base, item_type: "COMPETENCY", competency_id: cmp, equipment_class_id: mcu }])?.code).toBe(
      "INVALID_REQUIREMENT_REFERENCE",
    );
    expect(
      validateProfileItems([
        { ...base, item_type: "COMPETENCY", competency_id: cmp },
        { ...base, item_type: "COMPETENCY", competency_id: cmp },
      ])?.code,
    ).toBe("DUPLICATE");
    expect(validateProfileItems([{ ...base, item_type: "XYZ" }])?.code).toBe("VALIDATION_ERROR");
    expect(
      validateProfileItems([
        { ...base, item_type: "COMPETENCY", competency_id: cmp },
        { ...base, item_type: "MEDICAL", medical_exam_type_id: mcu },
      ]),
    ).toBeNull();
  });
});

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("Readiness API (integrasi)", () => {
  let db: Db;
  let issuer: Awaited<ReturnType<typeof makeIssuer>>;
  let app: ReturnType<typeof createApp>;
  const u: Record<string, string> = {};
  let org = "";
  let site = "";
  let pos = "";
  let cmp = "";
  let mcu = "";
  let worker = "";
  let profileId = "";
  const tag = Math.random().toString(36).slice(2, 8).toUpperCase();

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

  beforeAll(async () => {
    db = createPool(url);
    issuer = await makeIssuer();
    app = createApp({ db, auth: issuer.verifier });
    org = await one("select id from organization order by name limit 1");
    for (const who of ["admin", "hsemgr", "hseo1", "spv1", "medis"]) {
      u[who] = await one("select id from user_profile where organization_id = $1 and email like $2", [org, `${who}@%`]);
    }
    u.other = await one(
      "select id from user_profile where organization_id = (select id from organization order by name offset 1 limit 1) and email like 'admin@%'",
    );
    site = await one(
      "select scope_id as id from user_role_assignment where user_id = $1 and scope_type = 'SITE' and revoked_at is null limit 1",
      [u.hseo1],
    );
    pos = await one("insert into job_position (organization_id, name, code) values ($1, $2, $3) returning id", [
      org,
      `Uji Readiness ${tag}`,
      `UJI-RE-${tag}`,
    ]);
    cmp = await one("insert into competency (organization_id, name, code) values ($1, $2, $3) returning id", [
      org,
      `Uji RE Kompetensi ${tag}`,
      `UJI-RE-CMP-${tag}`,
    ]);
    mcu = await one("insert into medical_exam_type (organization_id, name, code) values ($1, $2, $3) returning id", [
      org,
      `Uji RE MCU ${tag}`,
      `UJI-RE-MCU-${tag}`,
    ]);
    worker = await one(
      `insert into worker (organization_id, site_id, full_name, employee_number, employment_status, join_date, job_position_id)
       values ($1, $2, $3, $4, 'PERMANENT', current_date - 30, $5) returning id`,
      [org, site, `Pekerja Uji Readiness ${tag}`, `UJI-RE-${tag}`, pos],
    );
  });
  afterAll(async () => {
    await db?.end();
  });

  const items = () => [
    { item_type: "COMPETENCY", competency_id: cmp },
    { item_type: "MEDICAL", medical_exam_type_id: mcu, warning_days: 14 },
  ];

  it("hanya pengelola profile yang dapat membuat draf; jenis dan rujukan divalidasi", async () => {
    expect((await call("hseo1", "/requirement-profiles", "POST", { job_position_id: pos, items: items() })).status).toBe(403);
    const training = await call("hsemgr", "/requirement-profiles", "POST", {
      job_position_id: pos,
      items: [{ item_type: "TRAINING" }],
    });
    expect(training.status).toBe(422);
    expect(training.body.error.code).toBe("ITEM_TYPE_NOT_AVAILABLE");
    const badRef = await call("hsemgr", "/requirement-profiles", "POST", {
      job_position_id: pos,
      items: [{ item_type: "COMPETENCY", competency_id: "00000000-0000-4000-8000-000000000009" }],
    });
    expect(badRef.status).toBe(422);
    expect(badRef.body.error.code).toBe("INVALID_REQUIREMENT_REFERENCE");

    const created = await call("hsemgr", "/requirement-profiles", "POST", {
      job_position_id: pos,
      notes: "Draf uji",
      items: items(),
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: "DRAFT", profile_version: 1, item_count: 2 });
    expect(created.body.data.items.map((i: { requirement_name: string }) => i.requirement_name)).toEqual([
      `Uji RE Kompetensi ${tag}`,
      `Uji RE MCU ${tag}`,
    ]);
    profileId = created.body.data.id;
    const again = await call("hsemgr", "/requirement-profiles", "POST", { job_position_id: pos, items: items() });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("CONFLICT");
  });

  it("draf dapat diganti dengan If-Match; profile kosong tidak dapat diaktifkan", async () => {
    const cur = await call("hsemgr", `/requirement-profiles/${profileId}`);
    const v = cur.body.data.version as number;
    expect(
      (await call("hsemgr", `/requirement-profiles/${profileId}`, "PUT", { items: [] }, { "If-Match": `"${v + 5}"` })).status,
    ).toBe(412);
    const emptied = await call("hsemgr", `/requirement-profiles/${profileId}`, "PUT", { items: [] }, { "If-Match": `"${v}"` });
    expect(emptied.status).toBe(200);
    expect(emptied.body.data.item_count).toBe(0);
    const empty = await call("hsemgr", `/requirement-profiles/${profileId}/activate`, "POST", undefined, {
      "If-Match": `"${emptied.body.data.version}"`,
    });
    expect(empty.status).toBe(409);
    expect(empty.body.error.code).toBe("PROFILE_EMPTY");
    const filled = await call(
      "hsemgr",
      `/requirement-profiles/${profileId}`,
      "PUT",
      { notes: "Draf uji final", items: items() },
      { "If-Match": `"${emptied.body.data.version}"` },
    );
    expect(filled.status).toBe(200);
    expect(filled.body.data.item_count).toBe(2);
  });

  it("aktivasi mengunci profile; versi baru disalin sebagai draf", async () => {
    const cur = await call("hsemgr", `/requirement-profiles/${profileId}`);
    const act = await call("hsemgr", `/requirement-profiles/${profileId}/activate`, "POST", undefined, {
      "If-Match": `"${cur.body.data.version}"`,
    });
    expect(act.status).toBe(200);
    expect(act.body.data.status).toBe("ACTIVE");
    expect(act.body.data.activated_at).toBeTruthy();
    const put = await call(
      "hsemgr",
      `/requirement-profiles/${profileId}`,
      "PUT",
      { items: items() },
      { "If-Match": `"${act.body.data.version}"` },
    );
    expect(put.body.error.code).toBe("PROFILE_NOT_DRAFT");
    expect((await call("hsemgr", `/requirement-profiles/${profileId}`, "DELETE")).body.error.code).toBe("PROFILE_NOT_DRAFT");
    const dup = await call("hsemgr", "/requirement-profiles", "POST", { job_position_id: pos, items: items() });
    expect(dup.body.error.code).toBe("POSITION_HAS_ACTIVE_PROFILE");

    const nv = await call("hsemgr", `/requirement-profiles/${profileId}/new-version`, "POST");
    expect(nv.status).toBe(201);
    expect(nv.body.data).toMatchObject({ status: "DRAFT", profile_version: 2, item_count: 2 });
    expect((await call("hsemgr", `/requirement-profiles/${profileId}/new-version`, "POST")).status).toBe(409);
    expect((await call("hsemgr", `/requirement-profiles/${nv.body.data.id}`, "DELETE")).status).toBe(200);

    const listed = await call("spv1", `/requirement-profiles?job_position_id=${pos}`);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].status).toBe("ACTIVE");
  });

  it("evaluasi manual: hasil per syarat, medis disamarkan bagi non-medis, scope ditegakkan", async () => {
    const ev = await call("hseo1", `/workers/${worker}/readiness/evaluate`, "POST");
    expect(ev.status).toBe(200);
    expect(ev.body.data).toMatchObject({ status: "NOT_READY", score: 0, reason_code: null, profile: { version: 1 } });
    const med = ev.body.data.items.find((i: { item_type: string }) => i.item_type === "MEDICAL");
    expect(med).toMatchObject({
      requirement_name: "Syarat Medical",
      requirement_status: "NOT_MET",
      reason_code: "MEDICAL_REQUIREMENT_NOT_MET",
      expiry_date: null,
      masked: true,
    });
    const comp = ev.body.data.items.find((i: { item_type: string }) => i.item_type === "COMPETENCY");
    expect(comp).toMatchObject({ requirement_status: "MISSING", masked: false });

    const asMedis = await call("medis", `/workers/${worker}/readiness`);
    expect(asMedis.status).toBe(200);
    expect(asMedis.body.data.items.find((i: { item_type: string }) => i.item_type === "MEDICAL")).toMatchObject({
      requirement_name: `Uji RE MCU ${tag}`,
      requirement_status: "MISSING",
      masked: false,
    });

    expect((await call("spv1", `/workers/${worker}/readiness/evaluate`, "POST")).status).toBe(403);
    expect((await call("other", `/workers/${worker}/readiness`)).status).toBe(404);

    const hist = await call("hseo1", `/workers/${worker}/readiness/history`);
    expect(hist.status).toBe(200);
    expect(hist.body.data.length).toBeGreaterThanOrEqual(1);
    const snap = await call("hseo1", `/readiness/snapshots/${hist.body.data[0].id}`);
    expect(snap.status).toBe(200);
    expect(snap.body.data.items).toHaveLength(2);
    const audited = await db.query(
      `select 1 from audit_outbox where payload->>'action' = 'readiness.evaluate' and payload->>'entity_id' = $1
       union all select 1 from audit_log where action = 'readiness.evaluate' and entity_id = $1::uuid`,
      [worker],
    );
    expect(audited.rowCount).toBeGreaterThan(0);
  });
});

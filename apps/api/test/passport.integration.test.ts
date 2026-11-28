import { createPool, type Db } from "@soh/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/create-app.js";
import { makeIssuer } from "./jwt-helper.js";

/** QR Safety Passport M4.3 (API-014 bagian 7). Data SINTETIS saja (B-24). Butuh DATABASE_URL. */
const url = process.env.DATABASE_URL;

describe.skipIf(!url)("QR Safety Passport API (integrasi)", () => {
  let db: Db;
  let issuer: Awaited<ReturnType<typeof makeIssuer>>;
  let app: ReturnType<typeof createApp>;
  const u: Record<string, string> = {};
  let self = "";
  let site = "";

  const call = async (
    who: string,
    path: string,
    method = "GET",
    headers: Record<string, string> = {},
    // biome-ignore lint/suspicious/noExplicitAny: bentuk respons diperiksa lewat expect
  ): Promise<{ status: number; body: any }> => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${await issuer.sign({ sub: u[who] as string })}`, ...headers },
    });
    return { status: res.status, body: await res.json() };
  };
  const one = async (sql: string, params: unknown[] = []) => (await db.query<{ id: string }>(sql, params)).rows[0]?.id as string;

  beforeAll(async () => {
    db = createPool(url);
    issuer = await makeIssuer();
    app = createApp({ db, auth: issuer.verifier });
    const org = await one("select id from organization order by name limit 1");
    u.pekerja = await one("select id from user_profile where organization_id = $1 and email like 'pekerja1@%'", [org]);
    u.spv = await one("select id from user_profile where organization_id = $1 and email like 'spv1@%'", [org]);
    u.other = await one(
      "select id from user_profile where organization_id = (select id from organization order by name offset 1 limit 1) and email like 'admin@%'",
    );
    self = await one("select id from worker where user_id = $1", [u.pekerja]);
    site = await one("select site_id as id from worker where id = $1", [self]);
    u.scan = await one(
      `select user_id as id from user_role_assignment where role_code = 'HSE_OFFICER' and scope_type = 'SITE'
        and scope_id = $1 and revoked_at is null limit 1`,
      [site],
    );
    u.far = await one(
      `select user_id as id from user_role_assignment where organization_id = $1 and role_code = 'HSE_OFFICER'
        and scope_type = 'SITE' and scope_id <> $2 and revoked_at is null limit 1`,
      [org, site],
    );
    await db.query("select app.readiness_evaluate($1, 'MANUAL', null)", [self]);
  });
  afterAll(async () => {
    await db?.end();
  });

  it("pekerja menerbitkan token untuk dirinya; pemindai berwenang melihat data minimal", async () => {
    const t = await call("pekerja", `/workers/${self}/passport/token`, "POST");
    expect(t.status).toBe(201);
    expect(t.body.data.token).toMatch(/^[0-9a-f]{64}$/);
    expect(t.body.data.refresh_after_seconds).toBe(240);
    const ttl = Date.parse(t.body.data.expires_at) - Date.now();
    expect(ttl).toBeGreaterThan(4 * 60_000);
    expect(ttl).toBeLessThanOrEqual(5 * 60_000 + 1000);

    const v = await call("scan", "/passport/verify", "GET", { "X-Passport-Token": t.body.data.token });
    expect(v.status).toBe(200);
    expect(v.body.data.worker_id).toBe(self);
    expect(v.body.data.photo_url).toBeNull();
    expect(Object.keys(v.body.data).sort()).toEqual(
      ["categories", "evaluated_at", "full_name", "job_position", "photo_url", "site", "status", "worker_id"].sort(),
    );
    expect(JSON.stringify(v.body.data)).not.toMatch(/national_id|nik|document_number|sho_id/i);

    expect((await call("far", "/passport/verify", "GET", { "X-Passport-Token": t.body.data.token })).status).toBe(404);
    expect((await call("other", "/passport/verify", "GET", { "X-Passport-Token": t.body.data.token })).status).toBe(404);
  });

  it("token rusak atau kedaluwarsa ditolak 401; pekerja tidak dapat memindai atau menerbitkan untuk orang lain", async () => {
    const bad = await call("scan", "/passport/verify", "GET", { "X-Passport-Token": "SHO-000001" });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("PASSPORT_TOKEN_INVALID");

    const t = await call("pekerja", `/workers/${self}/passport/token`, "POST");
    await db.query(
      "update passport_token set issued_at = now() - interval '10 minutes', expires_at = now() - interval '1 minute' where token_hash = sha256(convert_to($1, 'UTF8'))",
      [t.body.data.token],
    );
    const exp = await call("scan", "/passport/verify", "GET", { "X-Passport-Token": t.body.data.token });
    expect(exp.status).toBe(401);
    expect(exp.body.error.code).toBe("PASSPORT_TOKEN_EXPIRED");

    // pekerja (readiness.read SELF) bukan pemindai
    expect((await call("pekerja", "/passport/verify", "GET", { "X-Passport-Token": "a".repeat(64) })).status).toBe(403);
    const someoneElse = await one("select id from worker where site_id = $1 and id <> $2 limit 1", [site, self]);
    expect((await call("pekerja", `/workers/${someoneElse}/passport/token`, "POST")).status).toBe(404);
  });
});

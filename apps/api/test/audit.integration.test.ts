import { randomUUID } from "node:crypto";
import { createPool, type Db } from "@soh/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/create-app.js";
import { makeIssuer } from "./jwt-helper.js";

/**
 * Uji integrasi Audit Trail (SRS-PLT03 AC-001/005/009, API-016). Butuh DATABASE_URL ke database hasil
 * scripts/test-db.sh. Pemindah antrean dijalankan langsung lewat app.audit_drain (peran app_worker).
 */
const url = process.env.DATABASE_URL;

describe.skipIf(!url)("Audit Trail (integrasi)", () => {
  let db: Db;
  let issuer: Awaited<ReturnType<typeof makeIssuer>>;
  let app: ReturnType<typeof createApp>;
  const u: Record<string, string> = {};
  let orgA: string;
  const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const to = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const drain = () => db.query("set role app_worker; select app.audit_drain(100000); reset role;");
  const call = async (userId: string, path: string, headers: Record<string, string> = {}, sessionId?: string) => {
    const token = await issuer.sign({ sub: userId, ...(sessionId ? { session_id: sessionId } : {}) });
    return app.request(`/api/v1${path}`, { headers: { Authorization: `Bearer ${token}`, ...headers } });
  };
  const range = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  beforeAll(async () => {
    db = createPool(url);
    issuer = await makeIssuer();
    app = createApp({ db, auth: issuer.verifier });
    const orgs = await db.query<{ id: string }>("select id from organization order by name limit 2");
    orgA = orgs.rows[0]?.id as string;
    const orgB = orgs.rows[1]?.id as string;
    for (const [key, org, who] of [
      ["admin", orgA, "admin"],
      ["spv1", orgA, "spv1"],
      ["hsemgr", orgA, "hsemgr"],
      ["hseo2", orgA, "hseo2"],
      ["adminB", orgB, "admin"],
    ] as const) {
      const r = await db.query<{ id: string }>("select id from user_profile where organization_id = $1 and email like $2", [
        org,
        `${who}@%`,
      ]);
      u[key] = r.rows[0]?.id as string;
    }
    expect(Object.values(u).every(Boolean)).toBe(true);
  });

  afterAll(async () => {
    await db?.end();
  });

  it("tanpa rentang waktu -> 400 DATE_RANGE_REQUIRED; lebih dari 92 hari -> 400 DATE_RANGE_TOO_LARGE", async () => {
    let res = await call(u.admin as string, "/audit-logs");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "DATE_RANGE_REQUIRED" } });
    res = await call(u.admin as string, "/audit-logs?from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "DATE_RANGE_TOO_LARGE" } });
    res = await call(u.admin as string, `/audit-logs?${range}&action=DROP%20TABLE`);
    expect(res.status).toBe(422);
  });

  it("tanpa audit.view (Supervisor) dan level LIMITED (HSE Manager) -> 403 FORBIDDEN (AC-PLT03-009)", async () => {
    for (const who of [u.spv1, u.hsemgr]) {
      const res = await call(who as string, `/audit-logs?${range}`);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    }
  });

  it("penugasan role tercatat dengan pelaku, role yang dipakai, dan perubahan; organisasi lain tidak melihatnya", async () => {
    const ins = await db.query<{ id: string }>(
      `insert into user_role_assignment(user_id, organization_id, role_code, scope_type, granted_by)
       values ($1, $2, 'HSE_MANAGER', 'ORGANIZATION', $3) returning id`,
      [u.hseo2, orgA, u.admin],
    );
    const uraId = ins.rows[0]?.id as string;
    try {
      await drain();
      const res = await call(u.admin as string, `/audit-logs?${range}&action=access.role_assigned&entity_id=${uraId}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        actor_kind: "USER",
        actor: { user_id: u.admin, role_code: "COMPANY_ADMIN", scope_type: "ORGANIZATION" },
        action: "access.role_assigned",
        entity_type: "user_role_assignment",
        changes: { role_code: "HSE_MANAGER", scope_type: "ORGANIZATION" },
        result: "SUCCESS",
        sensitive_access: false,
      });
      expect(body.data[0]).toHaveProperty("ip"); // Company Admin melihat ip/user_agent
      const other = await call(u.adminB as string, `/audit-logs?${range}&entity_id=${uraId}`);
      expect((await other.json()).data).toEqual([]);
      const detail = await call(u.adminB as string, `/audit-logs/${body.data[0].id}`);
      expect(detail.status).toBe(404);
      const own = await call(u.admin as string, `/audit-logs/${body.data[0].id}`);
      expect(own.status).toBe(200);
    } finally {
      await db.query("update user_role_assignment set revoked_at = now(), revoked_by = $2 where id = $1", [uraId, u.admin]);
    }
  });

  it("pembacaan audit juga tercatat (audit.read) dengan request_id permintaan (AUD-API-005)", async () => {
    const rid = randomUUID();
    const res = await call(u.admin as string, `/audit-logs?${range}&limit=1`, { "X-Request-Id": rid });
    expect(res.status).toBe(200);
    await drain();
    const r = await db.query(
      "select actor_user_id, actor_role_code from audit_log where action = 'audit.read' and request_id = $1",
      [rid],
    );
    expect(r.rows).toEqual([{ actor_user_id: u.admin, actor_role_code: "COMPANY_ADMIN" }]);
  });

  it("login: sesi pertama kali dipakai tercatat sekali sebagai auth.login_success dengan IP klien (AUD-007)", async () => {
    const sid = randomUUID();
    const headers = { "X-Forwarded-For": "198.51.100.23, 10.0.0.1", "User-Agent": "UjiBrowser/1.0" };
    expect((await call(u.admin as string, "/auth/me", headers, sid)).status).toBe(200);
    expect((await call(u.admin as string, "/auth/me", headers, sid)).status).toBe(200);
    await drain();
    const r = await db.query<{ ip: string; user_agent: string }>(
      `select host(a.ip) as ip, a.user_agent from audit_log a join auth_session_seen s on s.user_id = a.actor_user_id
       where a.action = 'auth.login_success' and s.session_id = $1 and a.occurred_at >= s.first_seen_at - interval '1 minute'
         and a.actor_user_id = $2`,
      [sid, u.admin],
    );
    expect(r.rows.filter((x) => x.ip === "198.51.100.23" && x.user_agent === "UjiBrowser/1.0")).toHaveLength(1);
  });

  it("paginasi kursor: halaman berikutnya tidak mengulang kejadian", async () => {
    const p1 = await (await call(u.admin as string, `/audit-logs?${range}&limit=2`)).json();
    expect(p1.data).toHaveLength(2);
    expect(p1.pagination.has_more).toBe(true);
    const p2 = await (await call(u.admin as string, `/audit-logs?${range}&limit=2&cursor=${p1.pagination.next_cursor}`)).json();
    const ids1 = p1.data.map((e: { id: string }) => e.id);
    for (const e of p2.data) expect(ids1).not.toContain(e.id);
    expect((await call(u.admin as string, `/audit-logs?${range}&cursor=bukan-kursor`)).status).toBe(422);
  });
});

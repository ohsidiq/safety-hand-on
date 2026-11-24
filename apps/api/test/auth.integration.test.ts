import { OpenAPIHono } from "@hono/zod-openapi";
import { createPool, type Db } from "@soh/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AuthEnv, authenticate, requirePermission } from "../src/auth.js";
import { createApp } from "../src/create-app.js";
import { makeIssuer } from "./jwt-helper.js";

/**
 * Uji integrasi autentikasi (API-001 §9, AUTH-API-006/007, AC-PLT01-006). Butuh DATABASE_URL ke database
 * hasil scripts/test-db.sh. Perubahan status dan penugasan dikembalikan di akhir setiap uji.
 */
const url = process.env.DATABASE_URL;

describe.skipIf(!url)("Autentikasi + /auth/me (integrasi)", () => {
  let db: Db;
  let issuer: Awaited<ReturnType<typeof makeIssuer>>;
  let app: ReturnType<typeof createApp>;
  const u: Record<string, string> = {};
  let orgA: string;

  const me = async (userId: string) => {
    const token = await issuer.sign({ sub: userId });
    return app.request("/api/v1/auth/me", { headers: { Authorization: `Bearer ${token}` } });
  };

  beforeAll(async () => {
    db = createPool(url);
    issuer = await makeIssuer();
    app = createApp({ db, auth: issuer.verifier });
    orgA = (await db.query<{ id: string }>("select id from organization order by name limit 1")).rows[0]?.id as string;
    for (const who of ["admin", "spv1", "pekerja1", "medis", "hseo1"]) {
      const r = await db.query<{ id: string }>("select id from user_profile where organization_id = $1 and email like $2", [
        orgA,
        `${who}@%`,
      ]);
      u[who] = r.rows[0]?.id as string;
    }
    expect(Object.values(u).every(Boolean)).toBe(true);
  });

  afterAll(async () => {
    await db?.end();
  });

  it("Company Admin: profil, organisasi berkode, role ORGANIZATION, permission user.manage, tanpa Worker", async () => {
    const res = await me(u.admin as string);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.user_id).toBe(u.admin);
    expect(data.organization).toMatchObject({ id: orgA, code: expect.stringMatching(/^[A-Z0-9-]+$/) });
    expect(data.worker_id).toBeNull();
    expect(data.role_assignments).toEqual([
      expect.objectContaining({ role_code: "COMPANY_ADMIN", scope_type: "ORGANIZATION", scope_id: null, valid_until: null }),
    ]);
    expect(data.permissions).toContain("user.manage");
    expect(data.permissions).toEqual([...data.permissions].sort());
    expect(data.mfa_enabled).toBe(false);
  });

  it("Supervisor: penugasan scope SITE dengan scope_id, tanpa user.manage", async () => {
    const { data } = await (await me(u.spv1 as string)).json();
    expect(data.role_assignments).toEqual([
      expect.objectContaining({ role_code: "SUPERVISOR", scope_type: "SITE", scope_id: expect.any(String) }),
    ]);
    expect(data.permissions).toContain("worker.read");
    expect(data.permissions).not.toContain("user.manage");
  });

  it("Pekerja lapangan: worker_id dari worker.user_id (B-18), role WORKER scope SELF", async () => {
    const { data } = await (await me(u.pekerja1 as string)).json();
    const w = await db.query<{ id: string }>("select id from worker where user_id = $1", [u.pekerja1]);
    expect(data.worker_id).toBe(w.rows[0]?.id);
    expect(data.role_assignments).toEqual([expect.objectContaining({ role_code: "WORKER", scope_type: "SELF" })]);
    // hanya level FULL/TEAM; SELF (mis. worker.read milik sendiri) ditolak bawaan sampai aturan objeknya dibangun
    const full = await db.query<{ p: string }>(
      "select permission_code p from role_permission where role_code = 'WORKER' and constraint_level in ('FULL', 'TEAM') order by 1",
    );
    expect(data.permissions).toEqual(full.rows.map((r) => r.p).sort());
    expect(data.permissions).not.toContain("worker.read");
  });

  it("token sah untuk akun yang tidak ada -> 401 (tidak membocorkan keberadaan akun)", async () => {
    const res = await me("00000000-0000-4000-8000-000000000001");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("akun dinonaktifkan -> 403 ACCOUNT_DEACTIVATED, dikunci -> 423, undangan belum diterima -> 401", async () => {
    const set = (s: string) => db.query("update user_profile set status = $2 where id = $1", [u.medis, s]);
    try {
      await set("DEACTIVATED");
      let res = await me(u.medis as string);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: "ACCOUNT_DEACTIVATED" } });
      await set("LOCKED");
      res = await me(u.medis as string);
      expect(res.status).toBe(423);
      expect(await res.json()).toMatchObject({ error: { code: "ACCOUNT_LOCKED" } });
      await set("INVITED");
      expect((await me(u.medis as string)).status).toBe(401);
    } finally {
      await set("ACTIVE");
    }
    expect((await me(u.medis as string)).status).toBe(200);
  });

  it("pencabutan role berlaku pada permintaan berikutnya (AUTH-API-007)", async () => {
    // pengguna khusus uji ini: menambah peran pada akun seed bersama akan bocor ke uji lain yang berjalan paralel
    const tmp = (
      await db.query<{ id: string }>(
        "insert into user_profile (organization_id, email, full_name, status) values ($1, $2, 'Uji Pencabutan', 'ACTIVE') returning id",
        [orgA, `uji-cabut-${Math.random().toString(36).slice(2, 8)}@uji.contoh`],
      )
    ).rows[0]?.id as string;
    const ins = await db.query<{ id: string }>(
      `insert into user_role_assignment(user_id, organization_id, role_code, scope_type, granted_by)
       values ($1, $2, 'HSE_MANAGER', 'ORGANIZATION', $3) returning id`,
      [tmp, orgA, u.admin],
    );
    const id = ins.rows[0]?.id as string;
    try {
      let { data } = await (await me(tmp)).json();
      expect(data.role_assignments.map((r: { role_code: string }) => r.role_code)).toContain("HSE_MANAGER");
      expect(data.permissions).toContain("competency.verify");
      await db.query("update user_role_assignment set revoked_at = now(), revoked_by = $2 where id = $1", [id, u.admin]);
      ({ data } = await (await me(tmp)).json());
      expect(data.role_assignments.map((r: { role_code: string }) => r.role_code)).not.toContain("HSE_MANAGER");
      expect(data.permissions).not.toContain("competency.verify");
    } finally {
      await db.query("delete from user_role_assignment where id = $1", [id]);
    }
  });

  it("requirePermission: tanpa permission -> 403 FORBIDDEN, dengan permission -> lanjut", async () => {
    const probe = new OpenAPIHono<AuthEnv>();
    probe.use("*", async (c, next) => {
      c.set("requestId", "uji");
      await next();
    });
    probe.get("/kelola-pengguna", authenticate({ auth: issuer.verifier, db }), requirePermission("user.manage"), (c) =>
      c.json({ ok: true }),
    );
    const call = async (userId: string) =>
      probe.request("/kelola-pengguna", { headers: { Authorization: `Bearer ${await issuer.sign({ sub: userId })}` } });
    expect((await call(u.admin as string)).status).toBe(200);
    const denied = await call(u.spv1 as string);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ success: false, error: { code: "FORBIDDEN" }, request_id: "uji" });
  });
});

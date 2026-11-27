import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPool, type Db, withUser } from "@soh/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * AC-PLT01-006 / NFR "uji matrix permission pada setiap rilis": katalog di database harus sama persis dengan
 * packages/rbac/permission-matrix.json (salinan PB-009 v3.5 dan PB-008 v3.5).
 */
const url = process.env.DATABASE_URL;
const matrix = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/rbac/permission-matrix.json"), "utf8")) as {
  roles: { code: string; scope_levels: string[]; is_active: boolean }[];
  permissions: { code: string; is_sensitive: boolean }[];
  grants: { role: string; permission: string; level: string }[];
};

describe.skipIf(!url)("Matriks RBAC PB-009 (integrasi)", () => {
  let db: Db;
  beforeAll(() => {
    db = createPool(url);
  });
  afterAll(async () => {
    await db?.end();
  });

  it("katalog role sama dengan PB-008 (kode, scope, status aktif)", async () => {
    const { rows } = await db.query<{ code: string; scope_levels: string[]; is_active: boolean }>(
      'select code, scope_levels, is_active from role order by code collate "C"',
    );
    const expected = [...matrix.roles].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    expect(rows).toEqual(expected.map(({ code, scope_levels, is_active }) => ({ code, scope_levels, is_active })));
  });

  it("katalog permission sama dengan PB-009 (57 permission)", async () => {
    const { rows } = await db.query<{ code: string; is_sensitive: boolean }>(
      'select code, is_sensitive from permission order by code collate "C"',
    );
    expect(rows.length).toBe(57);
    expect(rows).toEqual(
      [...matrix.permissions]
        .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
        .map(({ code, is_sensitive }) => ({ code, is_sensitive })),
    );
  });

  it("pemetaan role ke permission dan level (✔ ◐ T S) sama persis dengan PB-009", async () => {
    const { rows } = await db.query<{ k: string }>(
      "select role_code || '|' || permission_code || '|' || constraint_level as k from role_permission",
    );
    const expected = matrix.grants.map((g) => `${g.role}|${g.permission}|${g.level}`).sort();
    expect(rows.map((r) => r.k).sort()).toEqual(expected);
  });

  it("Platform Super Admin tidak memiliki permission data pekerja (BR-PLT01-002)", async () => {
    const { rows } = await db.query(
      "select permission_code from role_permission where role_code = 'PLATFORM_SUPER_ADMIN' and permission_code like any (array['worker.%','medical.%','competency.%','readiness.%'])",
    );
    expect(rows).toEqual([]);
  });

  it("app.my_permissions mengembalikan permission efektif pengguna aktif", async () => {
    const admin = (
      await db.query<{ id: string }>("select id from user_profile where email like 'admin@%' order by email limit 1")
    ).rows[0]?.id as string;
    const perms = await withUser(db, admin, async (tx) =>
      (await tx.query<{ permission_code: string }>("select distinct permission_code from app.my_permissions()")).rows.map(
        (r) => r.permission_code,
      ),
    );
    const expected = matrix.grants.filter((g) => g.role === "COMPANY_ADMIN").map((g) => g.permission);
    expect(perms.sort()).toEqual([...new Set(expected)].sort());
  });
});

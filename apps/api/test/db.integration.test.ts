import { createPool, type Db, withUser } from "@soh/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

/**
 * Uji integrasi Core API -> PostgreSQL (butuh DATABASE_URL ke database yang sudah dimigrasi dan
 * diberi seed, mis. hasil scripts/test-db.sh). Membuktikan jalur ARCH-002: kueri lewat withUser
 * selalu terkena RLS, sehingga pengguna organisasi A tidak dapat membaca data organisasi B.
 */
const url = process.env.DATABASE_URL;

describe.skipIf(!url)("Core API + RLS (integrasi)", () => {
  let db: Db;
  let mgrA: string;
  let orgB: string;
  let spvA: string;
  let spvSite: string;

  beforeAll(async () => {
    db = createPool(url);
    const orgs = await db.query<{ id: string }>("select id from organization order by name limit 2");
    const orgA = orgs.rows[0]?.id as string;
    orgB = orgs.rows[1]?.id as string;
    const q = (pattern: string, org: string) =>
      db.query<{ id: string }>("select id from app_user where organization_id = $1 and email like $2", [org, pattern]);
    mgrA = (await q("hsemgr@%", orgA)).rows[0]?.id as string;
    spvA = (await q("spv1@%", orgA)).rows[0]?.id as string;
    spvSite = (await db.query<{ site_id: string }>("select site_id from user_role_assignment where user_id = $1", [spvA])).rows[0]
      ?.site_id as string;
    expect(mgrA && orgB && spvA && spvSite).toBeTruthy();
  });

  afterAll(async () => {
    await db?.end();
  });

  it("/health/ready melapor UP bila migrasi sudah diterapkan", async () => {
    const res = await createApp({ db }).request("/api/v1/health/ready");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { status: "UP" } });
  });

  it("withUser: manajer organisasi A tidak melihat satu pun pekerja organisasi B", async () => {
    const rows = await withUser(db, mgrA, async (tx) => {
      const own = await tx.query<{ n: number }>("select count(*)::int as n from worker");
      const other = await tx.query<{ n: number }>("select count(*)::int as n from worker where organization_id = $1", [orgB]);
      return { own: own.rows[0]?.n ?? 0, other: other.rows[0]?.n ?? -1 };
    });
    expect(rows.own).toBeGreaterThan(0);
    expect(rows.other).toBe(0);
  });

  it("withUser: supervisor hanya melihat pekerja di Site-nya", async () => {
    const sites = await withUser(db, spvA, async (tx) => {
      const r = await tx.query<{ site_id: string }>("select distinct site_id from worker");
      return r.rows.map((x) => x.site_id);
    });
    expect(sites).toEqual([spvSite]);
  });

  it("withUser: peran runtime bukan peran koneksi (RLS tidak dapat dilewati)", async () => {
    const role = await withUser(db, mgrA, async (tx) => (await tx.query<{ r: string }>("select current_user as r")).rows[0]?.r);
    expect(role).toBe("app_authenticated");
  });

  it("withUser menolak userId yang bukan UUID", async () => {
    await expect(withUser(db, "1 or 1=1", async () => 1)).rejects.toThrow();
  });
});

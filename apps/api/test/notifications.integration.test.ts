import { createPool, type Db } from "@soh/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/create-app.js";
import { makeIssuer } from "./jwt-helper.js";

/** Uji integrasi kotak masuk notifikasi (API-015 §2, NTF-API-001..003). Butuh DATABASE_URL (scripts/test-db.sh). */
const url = process.env.DATABASE_URL;

describe.skipIf(!url)("Notifikasi in-app (integrasi)", () => {
  let db: Db;
  let issuer: Awaited<ReturnType<typeof makeIssuer>>;
  let app: ReturnType<typeof createApp>;
  const u: Record<string, string> = {};
  let orgA: string;
  let uraId: string;

  const drainNotifications = async () => {
    for (let i = 0; i < 40; i++) {
      await db.query("set role app_worker; select app.notification_process(100000); reset role;");
      const left = await db.query<{ n: number }>("select count(*)::int as n from notification_event where status = 'PENDING'");
      if ((left.rows[0]?.n ?? 0) === 0) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const call = async (userId: string, path: string, method = "GET", body?: unknown) =>
    app.request(`/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await issuer.sign({ sub: userId })}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  beforeAll(async () => {
    db = createPool(url);
    issuer = await makeIssuer();
    app = createApp({ db, auth: issuer.verifier });
    orgA = (await db.query<{ id: string }>("select id from organization order by name limit 1")).rows[0]?.id as string;
    for (const who of ["admin", "spv2", "hseo3"]) {
      const r = await db.query<{ id: string }>("select id from user_profile where organization_id = $1 and email like $2", [
        orgA,
        `${who}@%`,
      ]);
      u[who] = r.rows[0]?.id as string;
    }
    await drainNotifications(); // bersihkan peristiwa seed
    // Supervisor 2 mendapat peran tambahan -> SYSTEM_ALERT/ACCESS_CHANGED untuknya
    const ins = await db.query<{ id: string }>(
      `insert into user_role_assignment(user_id, organization_id, role_code, scope_type, granted_by)
       values ($1, $2, 'EXECUTIVE', 'ORGANIZATION', $3) returning id`,
      [u.spv2, orgA, u.admin],
    );
    uraId = ins.rows[0]?.id as string;
    await drainNotifications();
  });

  afterAll(async () => {
    await db.query("update user_role_assignment set revoked_at = now(), revoked_by = $2 where id = $1 and revoked_at is null", [
      uraId,
      u.admin,
    ]);
    await db?.end();
  });

  it("penerima melihat notifikasi perubahan aksesnya, dengan isi dari template dan tanpa data pribadi", async () => {
    const res = await call(u.spv2 as string, "/notifications?unread_only=true");
    expect(res.status).toBe(200);
    const body = await res.json();
    const item = body.data.find((n: { entity: { id: string } | null }) => n.entity?.id === uraId);
    expect(item).toMatchObject({
      notification_type: "SYSTEM_ALERT",
      category: "SYSTEM",
      priority: "LOW",
      title: "Akses akun Anda berubah",
      link: "/profile",
      read_at: null,
    });
    expect(item.body).toContain("Executive");
    expect(item.body).toContain("diberikan");
    expect(item.body).not.toMatch(/[{}]/);
    expect(item.body).not.toContain("@");
  });

  it("pengguna lain tidak melihat dan tidak dapat menandai notifikasi itu (NTF-API-002)", async () => {
    const own = (await (await call(u.spv2 as string, "/notifications")).json()).data;
    const id = own.find((n: { entity: { id: string } | null }) => n.entity?.id === uraId).id as string;
    expect((await call(u.hseo3 as string, `/notifications/${id}`)).status).toBe(404);
    expect((await call(u.hseo3 as string, `/notifications/${id}/read`, "POST")).status).toBe(404);
    const others = (await (await call(u.hseo3 as string, "/notifications")).json()).data;
    expect(others.some((n: { id: string }) => n.id === id)).toBe(false);
  });

  it("tandai dibaca menurunkan jumlah belum dibaca dan idempoten; arsip menyembunyikan dari daftar", async () => {
    const before = (await (await call(u.spv2 as string, "/notifications/unread-count")).json()).data.unread as number;
    const own = (await (await call(u.spv2 as string, "/notifications?unread_only=true")).json()).data;
    const id = own.find((n: { entity: { id: string } | null }) => n.entity?.id === uraId).id as string;
    expect((await call(u.spv2 as string, `/notifications/${id}/read`, "POST")).status).toBe(200);
    const first = (await (await call(u.spv2 as string, `/notifications/${id}`)).json()).data.read_at;
    expect((await call(u.spv2 as string, `/notifications/${id}/read`, "POST")).status).toBe(200);
    expect((await (await call(u.spv2 as string, `/notifications/${id}`)).json()).data.read_at).toBe(first);
    expect((await (await call(u.spv2 as string, "/notifications/unread-count")).json()).data.unread).toBe(before - 1);
    expect((await call(u.spv2 as string, `/notifications/${id}/archive`, "POST")).status).toBe(200);
    const after = (await (await call(u.spv2 as string, "/notifications")).json()).data;
    expect(after.some((n: { id: string }) => n.id === id)).toBe(false);
  });

  it("tandai semua dibaca per kategori; kategori tidak valid -> 422", async () => {
    await db.query("update user_role_assignment set revoked_at = now(), revoked_by = $2 where id = $1", [uraId, u.admin]);
    await drainNotifications(); // notifikasi pencabutan
    expect((await (await call(u.spv2 as string, "/notifications/unread-count")).json()).data.unread).toBeGreaterThan(0);
    const res = await call(u.spv2 as string, "/notifications/read-all", "POST", { category: "SYSTEM" });
    expect(res.status).toBe(200);
    expect((await res.json()).data.updated).toBeGreaterThan(0);
    expect((await (await call(u.spv2 as string, "/notifications/unread-count")).json()).data.unread).toBe(0);
    expect((await call(u.spv2 as string, "/notifications/read-all", "POST", { category: "BUKAN" })).status).toBe(422);
    expect((await call(u.spv2 as string, "/notifications?cursor=rusak")).status).toBe(422);
  });

  it("tidak ada endpoint pembuatan notifikasi dari klien (NTF-API-001)", async () => {
    const res = await call(u.admin as string, "/notifications", "POST", { title: "palsu" });
    expect([404, 405]).toContain(res.status);
  });
});

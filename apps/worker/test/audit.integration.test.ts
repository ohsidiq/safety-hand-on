import { createPool, type Db } from "@soh/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drainAudit, ensureAuditPartitions } from "../src/audit.js";

/** Butuh DATABASE_URL ke database uji yang sudah dimigrasi dan diberi seed (scripts/test-db.sh). */
const url = process.env.DATABASE_URL;

describe.skipIf(!url)("Worker audit (integrasi)", () => {
  let db: Db;
  let org: string;

  beforeAll(async () => {
    db = createPool(url);
    org = (await db.query<{ id: string }>("select id from organization order by name limit 1")).rows[0]?.id as string;
  });
  afterAll(async () => {
    await db?.end();
  });

  it("memindahkan kejadian dari audit_outbox ke audit_log sebagai app_worker, tepat sekali", async () => {
    const ev = await db.query<{ id: string }>("select app.audit_enqueue($1, 'system.worker_test', 'organization', $1) as id", [
      org,
    ]);
    const id = ev.rows[0]?.id as string;
    const r = await drainAudit(db, 100000);
    expect(r.moved).toBeGreaterThanOrEqual(1);
    const row = await db.query("select actor_kind, action from audit_log where id = $1", [id]);
    expect(row.rows).toEqual([{ actor_kind: "SYSTEM", action: "system.worker_test" }]);
    // Uji lain dapat menambah kejadian bersamaan; yang dibuktikan: kejadian ini tidak tergandakan
    await drainAudit(db, 100000);
    expect((await db.query("select 1 from audit_log where id = $1", [id])).rowCount).toBe(1);
  });

  it("partisi bulanan dapat dijamin berulang tanpa membuat ganda", async () => {
    await ensureAuditPartitions(db, 3);
    expect(await ensureAuditPartitions(db, 3)).toBe(0);
  });
});

describe.skipIf(!url)("Worker notifikasi (integrasi)", () => {
  it("memproses peristiwa perubahan akses menjadi notifikasi, tepat sekali", async () => {
    const { processNotifications } = await import("../src/notifications.js");
    const db = createPool(url);
    try {
      const org = (await db.query<{ id: string }>("select id from organization order by name limit 1")).rows[0]?.id as string;
      const spv = (
        await db.query<{ id: string }>("select id from user_profile where organization_id = $1 and email like 'spv3@%'", [org])
      ).rows[0]?.id as string;
      const ev = await db.query<{ id: string }>(
        `insert into notification_event (organization_id, notification_type, variant, recipient_user_ids, payload, dedup_key)
         values ($1, 'SYSTEM_ALERT', 'ACCESS_CHANGED', array[$2::uuid], '{"role_label":"Uji","change_label":"diberikan"}',
                 'worker-test:' || gen_random_uuid()) returning id`,
        [org, spv],
      );
      const r = await processNotifications(db, 100000);
      expect(r.created).toBeGreaterThanOrEqual(1);
      const n = await db.query("select title from notification where event_id = $1", [ev.rows[0]?.id]);
      expect(n.rows).toEqual([{ title: "Akses akun Anda berubah" }]);
      await db.query("update notification_event set status = 'PENDING' where id = $1", [ev.rows[0]?.id]);
      await processNotifications(db, 100000);
      expect((await db.query("select 1 from notification where event_id = $1", [ev.rows[0]?.id])).rowCount).toBe(1);
    } finally {
      await db.end();
    }
  });
});

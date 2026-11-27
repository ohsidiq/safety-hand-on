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

describe.skipIf(!url)("Worker pengingat kedaluwarsa (integrasi)", () => {
  it("membuat peristiwa sekali per hari pengingat sebagai app_worker, lalu menjadi notifikasi", async () => {
    const { enqueueExpiryReminders, processNotifications } = await import("../src/notifications.js");
    const db = createPool(url);
    try {
      const row = (
        await db.query<{ org: string; site: string; worker: string; hseo: string; mgr: string }>(
          `select o.id as org, ura.scope_id as site,
                  (select w.id from worker w where w.site_id = ura.scope_id and w.user_id is null and w.worker_status = 'ACTIVE'
                    order by w.id desc limit 1) as worker,
                  ura.user_id as hseo,
                  (select id from user_profile where organization_id = o.id and email like 'hsemgr@%') as mgr
             from organization o join user_profile up on up.organization_id = o.id and up.email like 'hseo1@%'
             join user_role_assignment ura on ura.user_id = up.id and ura.scope_type = 'SITE' and ura.revoked_at is null
            order by o.name limit 1`,
        )
      ).rows[0];
      if (!row) throw new Error("seed tidak lengkap");
      const cmp = (
        await db.query<{ id: string }>(
          "insert into competency (organization_id, name, code) values ($1, 'Uji Worker Pengingat', 'UJI-WRK-' || upper(substr(md5(random()::text), 1, 6))) returning id",
          [row.org],
        )
      ).rows[0]?.id;
      const wc = (
        await db.query<{ id: string }>(
          `insert into worker_competency (organization_id, site_id, worker_id, competency_id, valid_from, valid_until, created_by,
                                          verification_status, verified_by, verified_at)
           values ($1, $2, $3, $4, app.site_today($2) - 100, app.site_today($2) + 14, $5, 'VERIFIED', $6, now()) returning id`,
          [row.org, row.site, row.worker, cmp, row.hseo, row.mgr],
        )
      ).rows[0]?.id;
      expect(await enqueueExpiryReminders(db)).toBeGreaterThanOrEqual(1);
      await enqueueExpiryReminders(db);
      const ev = await db.query("select id from notification_event where entity_id = $1", [wc]);
      expect(ev.rows).toHaveLength(1);
      await processNotifications(db, 100000);
      const n = await db.query<{ body: string; priority: string }>(
        "select body, priority from notification where entity_id = $1 and recipient_user_id = $2",
        [wc, row.hseo],
      );
      expect(n.rows[0]?.body).toContain("berakhir dalam 14 hari");
      expect(n.rows[0]?.priority).toBe("MEDIUM");
    } finally {
      await db.end();
    }
  });
});

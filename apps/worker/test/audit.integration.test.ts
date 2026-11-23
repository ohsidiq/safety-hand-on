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
    const again = await drainAudit(db, 100000);
    expect(again.moved).toBe(0);
    expect((await db.query("select 1 from audit_log where id = $1", [id])).rowCount).toBe(1);
  });

  it("partisi bulanan dapat dijamin berulang tanpa membuat ganda", async () => {
    await ensureAuditPartitions(db, 3);
    expect(await ensureAuditPartitions(db, 3)).toBe(0);
  });
});

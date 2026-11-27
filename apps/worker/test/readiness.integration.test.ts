import { createPool, type Db } from "@soh/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateDueReadiness, processReadiness } from "../src/readiness.js";

/** Butuh DATABASE_URL ke database uji yang sudah dimigrasi dan diberi seed (scripts/test-db.sh). */
const url = process.env.DATABASE_URL;

describe.skipIf(!url)("Worker Readiness Engine (integrasi)", () => {
  let db: Db;

  beforeAll(async () => {
    db = createPool(url);
  });
  afterAll(async () => {
    await db?.end();
  });

  it("memproses antrean kesiapan sebagai app_worker tanpa kegagalan dan tidak memproses ulang", async () => {
    // lewati debounce 5 detik untuk peristiwa seed (peran koneksi pemilik tabel di database uji)
    await db.query("update readiness_outbox set created_at = created_at - interval '1 minute' where status = 'PENDING'");
    const r1 = await processReadiness(db, 100000);
    expect(r1.failed).toBe(0);
    const r2 = await processReadiness(db, 100000);
    expect(r2.events).toBe(0);
  });

  it("evaluasi terjadwal mengisi hasil untuk setiap pekerja dan idempoten", async () => {
    await evaluateDueReadiness(db, 100000);
    const missing = await db.query<{ n: number }>(
      `select count(*)::int as n from worker w
        where w.deleted_at is null and not exists (select 1 from readiness_current rc where rc.worker_id = w.id)`,
    );
    expect(missing.rows[0]?.n).toBe(0);
    const before = await db.query<{ n: number }>("select count(*)::int as n from readiness_snapshot");
    await evaluateDueReadiness(db, 100000);
    const after = await db.query<{ n: number }>("select count(*)::int as n from readiness_snapshot");
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });
});

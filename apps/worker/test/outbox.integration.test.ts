import { createPool, type Db } from "@soh/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { processBatch } from "../src/outbox.js";

/** Butuh DATABASE_URL ke database uji yang sudah dimigrasi dan diberi seed (scripts/test-db.sh). */
const url = process.env.DATABASE_URL;

describe.skipIf(!url)("Worker outbox (integrasi)", () => {
  let db: Db;
  let org: string;

  beforeAll(async () => {
    db = createPool(url);
    org = (await db.query<{ id: string }>("select id from organization order by name limit 1")).rows[0]?.id as string;
  });
  afterAll(async () => {
    await db?.end();
  });
  beforeEach(async () => {
    // Bersihkan event uji sebelumnya (peran koneksi pemilik tabel di database uji).
    await db.query("delete from outbox_event where event_type like 'TEST_%' or event_type = 'SYSTEM_PING'");
  });

  async function enqueue(type: string, n = 1) {
    await db.query("insert into outbox_event(organization_id, event_type) select $1, $2 from generate_series(1, $3)", [
      org,
      type,
      n,
    ]);
  }

  it("memproses event dan menandai processed_at tepat sekali", async () => {
    await enqueue("SYSTEM_PING", 3);
    const seen: string[] = [];
    const r1 = await processBatch(db, { SYSTEM_PING: async (e) => void seen.push(e.id) });
    expect(r1).toMatchObject({ claimed: 3, processed: 3, failed: 0 });
    const r2 = await processBatch(db, { SYSTEM_PING: async (e) => void seen.push(e.id) });
    expect(r2.claimed).toBe(0);
    expect(new Set(seen).size).toBe(3);
  });

  it("satu event gagal tidak membatalkan event lain dalam batch", async () => {
    await enqueue("TEST_OK", 2);
    await enqueue("TEST_FAIL", 1);
    const r = await processBatch(
      db,
      {
        TEST_OK: async () => {},
        TEST_FAIL: async () => {
          throw new Error("gagal sementara");
        },
      },
      { maxAttempts: 3 },
    );
    expect(r).toMatchObject({ claimed: 3, processed: 2, retried: 1, failed: 0 });
    const row = (await db.query("select attempts, last_error, failed_at from outbox_event where event_type = 'TEST_FAIL'"))
      .rows[0];
    expect(row).toMatchObject({ attempts: 1, last_error: "gagal sementara", failed_at: null });
  });

  it("setelah maxAttempts, event masuk antrean gagal (failed_at)", async () => {
    await enqueue("TEST_FAIL", 1);
    const bad = {
      TEST_FAIL: async () => {
        throw new Error("x");
      },
    };
    await processBatch(db, bad, { maxAttempts: 2 });
    const r = await processBatch(db, bad, { maxAttempts: 2 });
    expect(r.failed).toBe(1);
    expect((await processBatch(db, bad, { maxAttempts: 2 })).claimed).toBe(0);
  });

  it("event tanpa handler langsung masuk antrean gagal", async () => {
    await enqueue("TEST_UNKNOWN", 1);
    const r = await processBatch(db, {});
    expect(r).toMatchObject({ claimed: 1, failed: 1 });
  });

  it("dua worker paralel tidak memproses event yang sama (SKIP LOCKED)", async () => {
    await enqueue("SYSTEM_PING", 40);
    const seen: string[] = [];
    const h = {
      SYSTEM_PING: async (e: { id: string }) => {
        seen.push(e.id);
        await new Promise((r) => setTimeout(r, 5));
      },
    };
    await Promise.all([processBatch(db, h, { batchSize: 25 }), processBatch(db, h, { batchSize: 25 })]);
    await processBatch(db, h, { batchSize: 25 });
    expect(seen.length).toBe(40);
    expect(new Set(seen).size).toBe(40);
  });
});

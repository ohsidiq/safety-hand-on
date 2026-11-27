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
    // hanya pekerja yang sudah ada sebelum uji: paket lain (uji API) dapat menambah pekerja secara paralel
    const ids = (await db.query<{ id: string }>("select id from worker where deleted_at is null")).rows.map((r) => r.id);
    await evaluateDueReadiness(db, 100000);
    const missing = await db.query<{ n: number }>(
      `select count(*)::int as n from unnest($1::uuid[]) w(id)
        where not exists (select 1 from readiness_current rc where rc.worker_id = w.id)`,
      [ids],
    );
    expect(missing.rows[0]?.n).toBe(0);
    const count = async () =>
      (
        await db.query<{ n: number }>("select count(*)::int as n from readiness_snapshot where worker_id = any ($1::uuid[])", [
          ids,
        ])
      ).rows[0]?.n;
    const before = await count();
    await evaluateDueReadiness(db, 100000);
    expect(await count()).toBe(before);
  });
});

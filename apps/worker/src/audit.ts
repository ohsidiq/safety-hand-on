import { type Db, withWorker } from "@soh/db";

/**
 * Pemindah antrean audit (DB-007 §2): audit_outbox -> audit_log, sebagai peran app_worker.
 * Idempoten (id kejadian = id outbox). Kejadian yang gagal 5 kali masuk antrean gagal dan tidak dihapus.
 */
export async function drainAudit(db: Db, batchSize = 500): Promise<{ moved: number; failed: number }> {
  return withWorker(db, async (tx) => {
    const r = await tx.query<{ moved: number; failed: number }>("select moved, failed from app.audit_drain($1)", [batchSize]);
    return { moved: r.rows[0]?.moved ?? 0, failed: r.rows[0]?.failed ?? 0 };
  });
}

/** Menjamin partisi audit bulan lalu sampai tiga bulan ke depan ada. Aman dipanggil berulang. */
export async function ensureAuditPartitions(db: Db, monthsAhead = 3): Promise<number> {
  return withWorker(db, async (tx) => {
    const r = await tx.query<{ n: number }>("select app.audit_ensure_partitions($1) as n", [monthsAhead]);
    return r.rows[0]?.n ?? 0;
  });
}

import { type Db, withWorker } from "@soh/db";

/**
 * Pemroses antrean kesiapan (M4.1, SRS-RE 7.2): peristiwa >= 5 detik digabung per pekerja lalu dievaluasi dengan engine
 * deterministik di database. Idempoten: evaluasi tanpa perubahan hasil tidak membuat snapshot baru (input_hash).
 */
export async function processReadiness(db: Db, batchSize = 500): Promise<{ events: number; workers: number; failed: number }> {
  return withWorker(db, async (tx) => {
    const r = await tx.query<{ events: number; workers: number; failed: number }>(
      "select events, workers, failed from app.readiness_process($1)",
      [batchSize],
    );
    return r.rows[0] ?? { events: 0, workers: 0, failed: 0 };
  });
}

/** Evaluasi terjadwal (SRS-RE 7.3): pekerja yang next_evaluation_at-nya lewat dan pekerja yang belum pernah dievaluasi. */
export async function evaluateDueReadiness(db: Db, limit = 1000): Promise<number> {
  return withWorker(db, async (tx) => {
    const r = await tx.query<{ n: number }>("select app.readiness_evaluate_due($1) as n", [limit]);
    return r.rows[0]?.n ?? 0;
  });
}

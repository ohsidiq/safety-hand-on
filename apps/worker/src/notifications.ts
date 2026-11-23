import { type Db, withWorker } from "@soh/db";

/**
 * Pemroses peristiwa notifikasi (BR-PLT02-005): notification_event -> notification, sebagai app_worker.
 * Idempoten lewat dedup per penerima; gagal 5 kali -> FAILED (antrean gagal) dan peringatan.
 */
export async function processNotifications(
  db: Db,
  batchSize = 200,
): Promise<{ processed: number; created: number; failed: number }> {
  return withWorker(db, async (tx) => {
    const r = await tx.query<{ processed: number; created: number; failed: number }>(
      "select processed, created, failed from app.notification_process($1)",
      [batchSize],
    );
    return r.rows[0] ?? { processed: 0, created: 0, failed: 0 };
  });
}

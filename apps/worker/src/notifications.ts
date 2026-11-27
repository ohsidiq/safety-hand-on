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

/**
 * Pengingat kedaluwarsa terjadwal (M3.6a, PB-019, SRS-PLT02 FR-017): membuat peristiwa EXPIRY dan tindak lanjut
 * Fit to Work dengan kondisi pada hari pengingat. Idempoten (dedup per item, tanggal, hari, audiens), aman diulang tiap jam.
 */
export async function enqueueExpiryReminders(db: Db): Promise<number> {
  return withWorker(db, async (tx) => {
    const r = await tx.query<{ n: number }>("select app.expiry_reminders_enqueue() as n");
    return r.rows[0]?.n ?? 0;
  });
}

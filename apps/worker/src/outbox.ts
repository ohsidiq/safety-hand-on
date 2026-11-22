import { type Db, type Tx, withWorker } from "@soh/db";

/**
 * Pemroses outbox transaksional (ARCH-005, ARCH-006).
 *
 * - Klaim batch dengan `FOR UPDATE SKIP LOCKED` sehingga beberapa worker aman berjalan bersama (spike S-3).
 * - Setiap event diproses di dalam SAVEPOINT: satu event gagal tidak membatalkan batch.
 * - Gagal berulang sampai `maxAttempts` -> `failed_at` diisi (antrean gagal, perlu alert).
 * - Efek eksternal (email, push) bersifat at-least-once: handler wajib memakai `event.id` sebagai kunci idempoten.
 */

export interface OutboxEvent {
  id: string;
  organization_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export type Handler = (event: OutboxEvent, tx: Tx) => Promise<void>;
export type HandlerRegistry = Record<string, Handler>;

export interface BatchResult {
  claimed: number;
  processed: number;
  retried: number;
  failed: number;
}

export interface ProcessOptions {
  batchSize?: number;
  maxAttempts?: number;
}

/** Pesan galat dipotong dan dibersihkan agar tidak menyimpan data sensitif panjang di database. */
function safeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, " ").slice(0, 300);
}

export async function processBatch(db: Db, handlers: HandlerRegistry, opts: ProcessOptions = {}): Promise<BatchResult> {
  const batchSize = opts.batchSize ?? 50;
  const maxAttempts = opts.maxAttempts ?? 5;

  return withWorker(db, async (tx) => {
    const { rows } = await tx.query<OutboxEvent>(
      `select id::text, organization_id, event_type, payload, attempts
         from outbox_event
        where processed_at is null and failed_at is null
        order by id
        for update skip locked
        limit $1`,
      [batchSize],
    );

    const result: BatchResult = { claimed: rows.length, processed: 0, retried: 0, failed: 0 };

    for (const event of rows) {
      const handler = handlers[event.event_type];
      await tx.query("savepoint ev");
      try {
        if (!handler) {
          throw new Error(`tidak ada handler untuk ${event.event_type}`);
        }
        await handler(event, tx);
        await tx.query("update outbox_event set processed_at = now(), last_error = null where id = $1", [event.id]);
        await tx.query("release savepoint ev");
        result.processed++;
      } catch (err) {
        await tx.query("rollback to savepoint ev");
        const attempts = event.attempts + 1;
        const giveUp = !handler || attempts >= maxAttempts;
        await tx.query(
          `update outbox_event
              set attempts = $2, last_error = $3, failed_at = case when $4 then now() else null end
            where id = $1`,
          [event.id, attempts, safeError(err), giveUp],
        );
        await tx.query("release savepoint ev");
        if (giveUp) result.failed++;
        else result.retried++;
      }
    }
    return result;
  });
}

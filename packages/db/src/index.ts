import pg from "pg";

/**
 * Akses database bersama untuk Core API dan worker.
 *
 * Aturan (ADR-001):
 * - ARCH-002: setiap kueri bisnis berjalan di dalam transaksi `withUser`, yang menurunkan hak
 *   ke peran `app_authenticated` dan mengatur `app.user_id`, sehingga RLS selalu berlaku.
 *   Tidak ada kueri bisnis yang memakai peran koneksi secara langsung.
 * - Worker memakai `withWorker` (peran `app_worker`), yang hanya boleh menangani outbox.
 */

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createPool(connectionString = process.env.DATABASE_URL): Db {
  if (!connectionString) {
    throw new Error("DATABASE_URL belum diatur");
  }
  return new pg.Pool({ connectionString, max: Number(process.env.DB_POOL_MAX ?? 5) });
}

async function inTransaction<T>(db: Db, setup: (tx: Tx) => Promise<void>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query("begin");
    await setup(tx);
    const result = await fn(tx);
    await tx.query("commit");
    return result;
  } catch (err) {
    await tx.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    tx.release();
  }
}

/** Menjalankan `fn` sebagai pengguna aplikasi tertentu, di bawah RLS. */
export function withUser<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(userId)) {
    return Promise.reject(new Error("userId harus UUID"));
  }
  return inTransaction(
    db,
    async (tx) => {
      await tx.query("set local role app_authenticated");
      await tx.query("select set_config('app.user_id', $1, true)", [userId]);
    },
    fn,
  );
}

/** Menjalankan `fn` sebagai worker outbox (peran `app_worker`). */
export function withWorker<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inTransaction(
    db,
    async (tx) => {
      await tx.query("set local role app_worker");
    },
    fn,
  );
}

/** Pemeriksaan kesiapan: database dapat dijangkau dan migrasi sudah diterapkan. */
export async function checkDatabase(db: Db): Promise<{ ok: boolean; migrations: number }> {
  const res = await db.query<{ n: string }>("select count(*)::text as n from schema_migrations");
  const migrations = Number(res.rows[0]?.n ?? 0);
  return { ok: migrations > 0, migrations };
}

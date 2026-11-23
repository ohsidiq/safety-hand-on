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

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", ""]);

/**
 * Opsi TLS: koneksi ke host non-lokal selalu dienkripsi.
 * - DATABASE_CA_CERT (PEM, sertifikat CA publik penyedia, bukan rahasia): sertifikat server diverifikasi penuh.
 * - Tanpa itu: terenkripsi tanpa verifikasi rantai sertifikat (cukup untuk staging data sintetis;
 *   wajib diisi sebelum data nyata, lihat REQ-ENV-001).
 */
/**
 * Mengurai connection string tanpa pernah membocorkan isinya. `new URL()` bawaan Node menyertakan
 * input (termasuk password) di pesan galat, jadi galat diganti dengan pesan generik.
 */
export function parseConnectionString(connectionString: string): URL {
  try {
    return new URL(connectionString);
  } catch {
    const err = new Error(
      "DATABASE_URL tidak valid. Periksa format URI; password dengan karakter khusus (# / ? @ : % ( ) [ ]) harus di-URL-encode.",
    );
    (err as Error & { code: string }).code = "DATABASE_URL_INVALID";
    throw err;
  }
}

export function sslOptions(connectionString: string, caCert = process.env.DATABASE_CA_CERT): pg.PoolConfig["ssl"] {
  const host = parseConnectionString(connectionString).hostname;
  if (LOCAL_HOSTS.has(host)) return undefined;
  return caCert ? { ca: caCert, rejectUnauthorized: true } : { rejectUnauthorized: false };
}

export function createPool(connectionString = process.env.DATABASE_URL): Db {
  if (!connectionString) {
    throw new Error("DATABASE_URL belum diatur");
  }
  // sslmode di URL diabaikan agar perilaku TLS hanya ditentukan sslOptions (konsisten lintas penyedia).
  const url = parseConnectionString(connectionString);
  url.searchParams.delete("sslmode");
  return new pg.Pool({
    connectionString: url.toString(),
    ssl: sslOptions(connectionString),
    max: Number(process.env.DB_POOL_MAX ?? 5),
  });
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

/** Konteks permintaan untuk Audit Trail (SRS-PLT03 §5): dibaca fungsi audit lewat GUC transaksi. */
export interface RequestContext {
  requestId?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

/** Menjalankan `fn` sebagai pengguna aplikasi tertentu, di bawah RLS. */
export function withUser<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>, ctx?: RequestContext): Promise<T> {
  if (!UUID_RE.test(userId)) {
    return Promise.reject(new Error("userId harus UUID"));
  }
  return inTransaction(
    db,
    async (tx) => {
      await tx.query("set local role app_authenticated");
      await tx.query(
        `select set_config('app.user_id', $1, true), set_config('app.request_id', $2, true),
                set_config('app.ip', $3, true), set_config('app.user_agent', $4, true)`,
        [userId, (ctx?.requestId ?? "").slice(0, 100), (ctx?.ip ?? "").slice(0, 64), (ctx?.userAgent ?? "").slice(0, 500)],
      );
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

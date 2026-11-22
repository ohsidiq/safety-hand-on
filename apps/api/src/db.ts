import { createPool, type Db } from "@soh/db";

/**
 * Membuat pool bila DATABASE_URL ada. Konfigurasi rusak tidak mematikan proses: Core API tetap
 * menjawab /health/live, /health/ready melapor DOWN, dan log hanya memuat kode galat (tanpa isi URI).
 */
export function createPoolSafe(url = process.env.DATABASE_URL): Db | undefined {
  if (!url) return undefined;
  try {
    return createPool(url);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    console.error(
      JSON.stringify({ level: "error", msg: "database pool not created", code: typeof code === "string" ? code : "UNKNOWN" }),
    );
    return undefined;
  }
}

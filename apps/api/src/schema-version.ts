/**
 * Nomor migrasi terakhir yang dibutuhkan kode ini (empat digit awal berkas terbaru di db/migrations).
 * WAJIB dinaikkan di PR yang menambah migrasi; uji `schema-version.test.ts` gagal bila tidak sama.
 * Dipakai /health/ready untuk melaporkan apakah database tertinggal dari kode yang ter-deploy.
 */
export const EXPECTED_SCHEMA = "0025";

export type SchemaState = "IN_SYNC" | "BEHIND" | "AHEAD" | "UNKNOWN";

/** BEHIND = database belum menerima migrasi yang dibutuhkan kode; AHEAD = database lebih baru dari kode (aman). */
export function schemaState(applied: string | null, expected: string = EXPECTED_SCHEMA): SchemaState {
  if (!applied) return "UNKNOWN";
  if (applied === expected) return "IN_SYNC";
  return applied < expected ? "BEHIND" : "AHEAD";
}

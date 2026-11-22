/** Konfigurasi runtime Core API dari variabel lingkungan (ARCH-009: nilai rahasia tidak pernah di kode). */
export function allowedOriginsFromEnv(value = process.env.API_ALLOWED_ORIGINS): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

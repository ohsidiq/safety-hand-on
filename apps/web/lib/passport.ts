import type { ItemType, ReadinessStatus } from "./readiness";

/**
 * QR Safety Passport (API-014 bagian 7, migrasi 0024). Isi QR adalah tautan ke halaman pindai dengan token di bagian
 * fragmen (#t=...), sehingga token tidak terkirim ke log server web dan kamera bawaan ponsel pun dapat membukanya.
 * Token berlaku 5 menit dan diperbarui otomatis tiap 4 menit oleh layar pekerja.
 */
export interface PassportToken {
  token: string;
  expires_at: string;
  refresh_after_seconds: number;
}

export interface PassportVerification {
  worker_id: string;
  full_name: string;
  photo_url: string | null;
  job_position: string | null;
  site: string | null;
  status: ReadinessStatus | null;
  categories: { item_type: ItemType; ok: boolean; warning: "EXPIRING_SOON" | "RESTRICTED" | null }[];
  evaluated_at: string | null;
}

const TOKEN_RE = /^[0-9a-f]{64}$/;

export function passportUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/passport/scan#t=${token}`;
}

/** Mengambil token dari hasil pindai: tautan passport (#t=...) atau token mentah. Selain itu null. */
export function parseScanned(text: string): string | null {
  const s = text.trim();
  if (TOKEN_RE.test(s)) return s;
  const m = s.match(/#t=([0-9a-f]{64})(?:$|&)/);
  return m?.[1] ?? null;
}

/** Sisa detik sampai token kedaluwarsa (tidak negatif). */
export function secondsLeft(expiresAt: string, now = Date.now()): number {
  return Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
}

export const WARNING_LABEL: Record<"EXPIRING_SOON" | "RESTRICTED", string> = {
  EXPIRING_SOON: "segera berakhir",
  RESTRICTED: "dengan pembatasan",
};

/** Pesan galat; menerima galat apiSend maupun hasil gagal apiGet (keduanya punya `code`). */
export function passportErrorMessage(e: { code?: string }): string {
  switch (e.code) {
    case "PASSPORT_TOKEN_EXPIRED":
      return "QR sudah kedaluwarsa. Minta pekerja menampilkan QR terbaru.";
    case "PASSPORT_TOKEN_INVALID":
      return "QR tidak dikenali. Pastikan yang dipindai adalah QR Safety Passport.";
    case "NOT_FOUND":
      return "Pekerja ini di luar cakupan Anda atau tidak ditemukan.";
    case "WORKER_INACTIVE":
      return "Pekerja tidak aktif, QR tidak dapat dibuat.";
    case "FORBIDDEN":
    case "SCOPE_DENIED":
      return "Anda tidak berwenang memindai QR.";
    case "NETWORK_ERROR":
    case "UNAVAILABLE":
      return "Server tidak dapat dihubungi. Periksa koneksi lalu coba lagi.";
    default:
      return "Permintaan gagal. Coba lagi.";
  }
}

/** Katalog kode galat API-000 bagian 7 dan API-001 bagian 10. Pesan tidak memuat data sensitif atau detail internal. */
export const errorStatus = {
  BAD_REQUEST: 400,
  ACCESS_REASON_REQUIRED: 400,
  DATE_RANGE_REQUIRED: 400,
  DATE_RANGE_TOO_LARGE: 400,
  UNAUTHORIZED: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  SCOPE_DENIED: 403,
  AI_DISABLED: 403,
  ACCOUNT_DEACTIVATED: 403,
  SEPARATION_OF_DUTIES: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DUPLICATE: 409,
  INVALID_STATE_TRANSITION: 409,
  ASSIGNMENT_OVERLAP: 409,
  VERSION_CONFLICT: 412,
  PAYLOAD_TOO_LARGE: 413,
  ACCOUNT_LOCKED: 423,
  VALIDATION_ERROR: 422,
  IDEMPOTENCY_MISMATCH: 422,
  DEPARTMENT_NOT_IN_SITE: 422,
  CONTRACTOR_REQUIRED: 422,
  CONTRACTOR_NOT_ALLOWED: 422,
  REASON_REQUIRED: 422,
  SITE_NOT_LINKED_TO_CONTRACTOR: 422,
  IMPORT_VALIDATION_FAILED: 422,
  FILE_NOT_CLEAN: 422,
  INVALID_DATE_RANGE: 422,
  WORK_SCOPE_REQUIRED: 422,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof errorStatus;

const messages: Record<ErrorCode, string> = {
  BAD_REQUEST: "Permintaan tidak dapat diproses",
  ACCESS_REASON_REQUIRED: "Alasan akses wajib diisi",
  DATE_RANGE_REQUIRED: "Rentang waktu from dan to wajib diisi",
  DATE_RANGE_TOO_LARGE: "Rentang waktu maksimum 92 hari",
  UNAUTHORIZED: "Autentikasi tidak valid",
  TOKEN_EXPIRED: "Sesi kedaluwarsa",
  FORBIDDEN: "Tidak memiliki izin",
  SCOPE_DENIED: "Di luar cakupan akses",
  AI_DISABLED: "AI belum diaktifkan",
  ACCOUNT_DEACTIVATED: "Akun dinonaktifkan",
  SEPARATION_OF_DUTIES: "Pemverifikasi tidak boleh pembuat data",
  NOT_FOUND: "Tidak ditemukan",
  CONFLICT: "Konflik keadaan",
  DUPLICATE: "Data duplikat",
  INVALID_STATE_TRANSITION: "Aksi status tidak sesuai status saat ini",
  ASSIGNMENT_OVERLAP: "Rentang penempatan tumpang tindih",
  VERSION_CONFLICT: "Versi data tidak cocok",
  PAYLOAD_TOO_LARGE: "Ukuran melebihi batas",
  ACCOUNT_LOCKED: "Akun dikunci sementara",
  VALIDATION_ERROR: "Data tidak valid",
  IDEMPOTENCY_MISMATCH: "Kunci idempotensi dipakai dengan isi berbeda",
  DEPARTMENT_NOT_IN_SITE: "Department bukan milik Site",
  CONTRACTOR_REQUIRED: "Pekerja kontraktor wajib memiliki kontraktor",
  CONTRACTOR_NOT_ALLOWED: "Kontraktor hanya untuk status kerja CONTRACTOR",
  REASON_REQUIRED: "Alasan wajib diisi",
  SITE_NOT_LINKED_TO_CONTRACTOR: "Site tidak terhubung ke kontraktor pekerja",
  IMPORT_VALIDATION_FAILED: "Impor dibatalkan karena ada baris yang gagal",
  FILE_NOT_CLEAN: "Berkas belum lolos pemeriksaan",
  INVALID_DATE_RANGE: "Tanggal akhir lebih awal dari tanggal mulai",
  WORK_SCOPE_REQUIRED: "Jenis otorisasi ini mensyaratkan lingkup pekerjaan",
  RATE_LIMITED: "Terlalu banyak permintaan",
  QUOTA_EXCEEDED: "Kuota terlampaui",
  INTERNAL_ERROR: "Terjadi galat pada server",
  SERVICE_UNAVAILABLE: "Layanan sementara tidak tersedia",
};

export interface ErrorDetail {
  field?: string;
  issue: string;
}

export function errorBody(code: ErrorCode, requestId: string, details?: ErrorDetail[]) {
  return {
    success: false as const,
    error: { code, message: messages[code], ...(details?.length ? { details } : {}) },
    request_id: requestId,
  };
}

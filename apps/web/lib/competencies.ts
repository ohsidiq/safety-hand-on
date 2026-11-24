import type { ApiError } from "./api";

/** Kompetensi pekerja (API-004). validity_status hanya informasi; penentu kesiapan tetap Readiness Engine. */
export type VerificationStatus = "PENDING" | "VERIFIED" | "REJECTED";
export type ValidityStatus = "VALID" | "EXPIRING_SOON" | "EXPIRED" | "PENDING_VERIFICATION" | "REJECTED";
export type CompetencySource = "CERTIFICATE" | "TRAINING" | "ASSESSMENT" | "OTHER";

export interface CompetencyMaster {
  id: string;
  name: string;
  code: string;
  description: string | null;
  default_validity_months: number | null;
  status: "ACTIVE" | "INACTIVE";
  version: number;
}

export interface WorkerCompetency {
  id: string;
  worker_id: string;
  site_id: string;
  worker_name: string | null;
  sho_id: string | null;
  competency: { id: string; name: string | null; code: string | null };
  valid_from: string;
  valid_until: string | null;
  source: CompetencySource;
  verification_status: VerificationStatus;
  validity_status: ValidityStatus;
  verified_by_name: string | null;
  verified_at: string | null;
  verification_comment: string | null;
  rejection_reason: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  certificate_count: number;
  can_verify: boolean;
}

export interface CompetencyCertificate {
  id: string;
  certificate_number: string | null;
  issuer: string | null;
  issue_date: string;
  expiry_date: string | null;
  file_id: string | null;
  file_name: string | null;
}

export const VALIDITY_LABEL: Record<ValidityStatus, string> = {
  VALID: "Berlaku",
  EXPIRING_SOON: "Segera berakhir",
  EXPIRED: "Kedaluwarsa",
  PENDING_VERIFICATION: "Menunggu verifikasi",
  REJECTED: "Ditolak",
};

/** Kelas badge; warna selalu disertai teks (aksesibilitas). */
export const VALIDITY_BADGE: Record<ValidityStatus, string> = {
  VALID: "badge badge-success",
  EXPIRING_SOON: "badge badge-warning",
  EXPIRED: "badge badge-failed",
  PENDING_VERIFICATION: "badge badge-neutral",
  REJECTED: "badge badge-failed",
};

export const SOURCE_LABEL: Record<CompetencySource, string> = {
  CERTIFICATE: "Sertifikat",
  TRAINING: "Pelatihan",
  ASSESSMENT: "Asesmen",
  OTHER: "Lainnya",
};

export interface CompetencyInput {
  competency_id: string;
  valid_from: string;
  valid_until: string;
  issue_date: string;
  expiry_date: string;
}

/** Validasi klien sebelum dikirim (server tetap memeriksa). `today` = YYYY-MM-DD. */
export function validateCompetencyInput(v: CompetencyInput, today: string, hasFile: boolean): string | null {
  if (!v.competency_id) return "Pilih kompetensi.";
  if (!v.valid_from) return "Tanggal mulai berlaku wajib diisi.";
  if (v.valid_from > today) return "Tanggal mulai berlaku tidak boleh di masa depan.";
  if (v.valid_until && v.valid_until < v.valid_from) return "Berlaku sampai tidak boleh lebih awal dari tanggal mulai.";
  if (hasFile) {
    if (!v.issue_date) return "Tanggal terbit sertifikat wajib diisi.";
    if (v.expiry_date && v.expiry_date < v.issue_date) return "Tanggal kedaluwarsa sertifikat lebih awal dari tanggal terbit.";
  }
  return null;
}

/** Tanggal berakhir bawaan dari masa berlaku master (bulan), untuk membantu pengisian. */
export function suggestUntil(from: string, months: number | null): string {
  if (!from || !months) return "";
  const d = new Date(`${from}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  // akhir bulan dipertahankan: 31 Jan + 1 bulan = 28/29 Feb, bukan awal Maret
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

export function competencyErrorMessage(e: ApiError): string {
  switch (e.code) {
    case "SEPARATION_OF_DUTIES":
      return "Data yang Anda catat harus diverifikasi orang lain.";
    case "INVALID_STATE_TRANSITION":
      return "Status verifikasi sudah berubah. Muat ulang halaman.";
    case "VERSION_CONFLICT":
      return "Data diubah orang lain. Muat ulang lalu coba lagi.";
    case "REASON_REQUIRED":
      return "Alasan penolakan wajib diisi.";
    case "INVALID_DATE_RANGE":
      return "Tanggal akhir lebih awal dari tanggal mulai.";
    case "FILE_NOT_CLEAN":
      return "Berkas sertifikat belum lolos pemeriksaan. Unggah ulang.";
    case "DUPLICATE":
      return e.details.some((d) => d.field === "file_id") ? "Berkas ini sudah dipakai sertifikat lain." : "Kode sudah dipakai.";
    case "FORBIDDEN":
    case "SCOPE_DENIED":
      return "Anda tidak berwenang untuk aksi ini.";
    case "NOT_FOUND":
      return "Data tidak ditemukan atau di luar cakupan Anda.";
    case "VALIDATION_ERROR":
      if (e.details.some((d) => d.issue === "in_future")) return "Tanggal mulai berlaku tidak boleh di masa depan.";
      if (e.details.some((d) => d.field === "competency_id")) return "Kompetensi tidak aktif atau tidak ditemukan.";
      return "Data tidak valid. Periksa kembali isian.";
    case "UNAVAILABLE":
      return "Server tidak dapat dihubungi. Coba lagi.";
    default:
      return "Permintaan gagal. Coba lagi.";
  }
}

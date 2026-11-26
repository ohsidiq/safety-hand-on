import type { ApiError } from "./api";

/**
 * Medical (API-005). Data Sensitif: hanya status Fit to Work, masa berlaku, dan pembatasan OPERASIONAL.
 * Diagnosis tidak pernah diminta atau ditampilkan. Detail hanya untuk Medical Officer, pekerja sendiri,
 * dan HSE Manager dengan otorisasi tercatat.
 */
export type Fitness = "FIT" | "FIT_WITH_RESTRICTION" | "TEMPORARILY_UNFIT" | "UNFIT";
export type MedicalValidity = "VALID" | "EXPIRING_SOON" | "EXPIRED" | "MISSING" | "PENDING_VERIFICATION" | "SUSPENDED";

export interface MedicalRestriction {
  id: string;
  restriction_code: string;
  operational_description: string;
  valid_from: string;
  valid_until: string | null;
  status?: "ACTIVE" | "LIFTED";
  lift_reason?: string | null;
}

export interface MedicalStatus {
  worker_id: string;
  fitness_status: Fitness | null;
  validity_status: MedicalValidity;
  expiry_date: string | null;
  unfit_until: string | null;
  restrictions: MedicalRestriction[];
  has_pending: boolean;
}

export interface MedicalRecord {
  id: string;
  worker_id: string;
  worker_name: string | null;
  sho_id: string | null;
  exam_type: { id: string; name: string | null; code: string | null };
  examination_date: string;
  expiry_date: string;
  provider: string | null;
  has_document: boolean;
  fitness_status: Fitness | null;
  unfit_until: string | null;
  verification_status: "PENDING" | "VERIFIED" | "REJECTED";
  verified_by_name: string | null;
  determination_comment: string | null;
  rejection_reason: string | null;
  created_by_name: string | null;
  updated_at: string;
  version: number;
  restrictions: MedicalRestriction[];
  can_determine: boolean;
}

export interface MedicalExamType {
  id: string;
  name: string;
  code: string;
  default_validity_months: number | null;
  status: "ACTIVE" | "INACTIVE";
}

export const FITNESS_LABEL: Record<Fitness, string> = {
  FIT: "Fit",
  FIT_WITH_RESTRICTION: "Fit dengan pembatasan",
  TEMPORARILY_UNFIT: "Tidak fit sementara",
  UNFIT: "Tidak fit",
};

export const MEDICAL_VALIDITY_LABEL: Record<MedicalValidity, string> = {
  VALID: "Berlaku",
  EXPIRING_SOON: "Segera berakhir",
  EXPIRED: "Kedaluwarsa",
  MISSING: "Belum ada MCU",
  PENDING_VERIFICATION: "Menunggu penetapan",
  SUSPENDED: "Tidak fit",
};

export const MEDICAL_VALIDITY_BADGE: Record<MedicalValidity, string> = {
  VALID: "badge badge-success",
  EXPIRING_SOON: "badge badge-warning",
  EXPIRED: "badge badge-failed",
  MISSING: "badge badge-neutral",
  PENDING_VERIFICATION: "badge badge-neutral",
  SUSPENDED: "badge badge-failed",
};

/** Kode pembatasan operasional baku (O-02): batasan kerja, bukan kondisi medis. */
export const RESTRICTION_CODES: { code: string; description: string }[] = [
  { code: "NO_WORK_AT_HEIGHT", description: "Tidak bekerja di ketinggian di atas 2 meter" },
  { code: "NO_HEAVY_EQUIPMENT", description: "Tidak mengoperasikan alat berat" },
  { code: "NO_NIGHT_SHIFT", description: "Tidak bekerja shift malam" },
  { code: "NO_CONFINED_SPACE", description: "Tidak masuk ruang terbatas" },
  { code: "LIGHT_DUTY_ONLY", description: "Hanya pekerjaan ringan" },
  { code: "NO_HEAVY_LIFTING", description: "Tidak mengangkat beban berat" },
];

/** Alasan akses detail minimal 10 karakter (API-005 §7). */
export const MIN_ACCESS_REASON = 10;

export interface DeterminationInput {
  fitness: Fitness | "";
  unfit_until: string;
  restriction_code: string;
  restriction_until: string;
}

/** Aturan penetapan (sama dengan server): pembatasan hanya untuk FIT_WITH_RESTRICTION, tanggal untuk tidak fit sementara. */
export function validateDetermination(v: DeterminationInput, today: string): string | null {
  if (!v.fitness) return "Pilih status Fit to Work.";
  if (v.fitness === "FIT_WITH_RESTRICTION" && !v.restriction_code) return "Pilih pembatasan operasional.";
  if (v.fitness === "TEMPORARILY_UNFIT" && !v.unfit_until) return "Isi tanggal tidak fit sampai.";
  if (v.fitness === "TEMPORARILY_UNFIT" && v.unfit_until < today) return "Tanggal tidak fit sampai sudah lewat.";
  if (v.restriction_until && v.restriction_until < today) return "Pembatasan berakhir sebelum hari ini.";
  return null;
}

export function medicalErrorMessage(e: ApiError): string {
  switch (e.code) {
    case "ACCESS_REASON_REQUIRED":
      return `Isi alasan akses (minimal ${MIN_ACCESS_REASON} karakter).`;
    case "SEPARATION_OF_DUTIES":
      return "Record yang Anda catat harus ditetapkan Medical Officer lain.";
    case "RESTRICTION_REQUIRED":
      return "Fit dengan pembatasan wajib memiliki pembatasan operasional.";
    case "RESTRICTION_NOT_ALLOWED":
      return "Pembatasan hanya untuk Fit dengan pembatasan.";
    case "UNFIT_UNTIL_REQUIRED":
      return "Isi tanggal tidak fit sampai.";
    case "GRANTEE_NOT_ELIGIBLE":
      return "Penerima tidak berhak menerima akses detail medis.";
    case "INVALID_DATE_RANGE":
      return "Tanggal berakhir lebih awal dari tanggal pemeriksaan.";
    case "INVALID_STATE_TRANSITION":
      return "Status record sudah berubah. Muat ulang.";
    case "VERSION_CONFLICT":
      return "Data diubah orang lain. Muat ulang lalu coba lagi.";
    case "REASON_REQUIRED":
      return "Alasan wajib diisi.";
    case "FILE_NOT_CLEAN":
      return "Dokumen belum lolos pemeriksaan. Unggah ulang.";
    case "NOT_FOUND":
      return "Data tidak ditemukan atau Anda tidak berwenang melihatnya.";
    case "FORBIDDEN":
    case "SCOPE_DENIED":
      return "Anda tidak berwenang untuk aksi ini.";
    case "VALIDATION_ERROR":
      if (e.details.some((d) => d.issue === "in_future")) return "Tanggal pemeriksaan tidak boleh di masa depan.";
      return "Data tidak valid. Periksa kembali isian.";
    default:
      return "Permintaan gagal. Coba lagi.";
  }
}

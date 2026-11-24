import type { ApiError } from "./api";

/** Otorisasi Kerja (API-006). Bukan Permit To Work. validity_status hanya informasi (penentu: Readiness Engine). */
export type AuthValidity = "VALID" | "EXPIRING_SOON" | "EXPIRED" | "PENDING_VERIFICATION" | "REJECTED" | "SUSPENDED";
export type SuspensionStatus = "NONE" | "SUSPENDED" | "REVOKED";

export interface AuthorizationType {
  id: string;
  name: string;
  code: string;
  description: string | null;
  requires_work_scope: boolean;
  default_validity_months: number | null;
  status: "ACTIVE" | "INACTIVE";
  version: number;
}

export interface WorkerAuthorization {
  id: string;
  worker_id: string;
  worker_name: string | null;
  sho_id: string | null;
  authorization_type: { id: string; name: string | null; code: string | null; requires_work_scope: boolean | null };
  authorization_number: string | null;
  issuer: string | null;
  work_scope: string | null;
  restriction_note: string | null;
  valid_from: string;
  valid_until: string | null;
  has_document: boolean;
  verification_status: "PENDING" | "VERIFIED" | "REJECTED";
  suspension_status: SuspensionStatus;
  validity_status: AuthValidity;
  verified_by_name: string | null;
  verified_at: string | null;
  verification_comment: string | null;
  rejection_reason: string | null;
  suspended_by_name: string | null;
  suspended_at: string | null;
  suspension_reason: string | null;
  created_by_name: string | null;
  updated_at: string;
  version: number;
  can_verify: boolean;
}

export const AUTH_VALIDITY_LABEL: Record<AuthValidity, string> = {
  VALID: "Berlaku",
  EXPIRING_SOON: "Segera berakhir",
  EXPIRED: "Kedaluwarsa",
  PENDING_VERIFICATION: "Menunggu verifikasi",
  REJECTED: "Ditolak",
  SUSPENDED: "Dibekukan",
};

export const AUTH_VALIDITY_BADGE: Record<AuthValidity, string> = {
  VALID: "badge badge-success",
  EXPIRING_SOON: "badge badge-warning",
  EXPIRED: "badge badge-failed",
  PENDING_VERIFICATION: "badge badge-neutral",
  REJECTED: "badge badge-failed",
  SUSPENDED: "badge badge-failed",
};

/** Label status untuk tampilan: REVOKED dibedakan dari SUSPENDED walau validity_status sama. */
export function authStatusLabel(a: Pick<WorkerAuthorization, "validity_status" | "suspension_status">): string {
  return a.suspension_status === "REVOKED" ? "Dicabut" : AUTH_VALIDITY_LABEL[a.validity_status];
}

/** Aksi pembekuan yang sah dari status saat ini (BR-WF005-015). */
export function suspensionActions(s: SuspensionStatus): ("suspend" | "reinstate" | "revoke")[] {
  if (s === "NONE") return ["suspend", "revoke"];
  if (s === "SUSPENDED") return ["reinstate", "revoke"];
  return [];
}

export interface AuthorizationInput {
  type: AuthorizationType | undefined;
  valid_from: string;
  valid_until: string;
  work_scope: string;
}

export function validateAuthorizationInput(v: AuthorizationInput, today: string): string | null {
  if (!v.type) return "Pilih jenis otorisasi.";
  if (!v.valid_from) return "Tanggal mulai berlaku wajib diisi.";
  if (v.valid_from > today) return "Tanggal mulai berlaku tidak boleh di masa depan.";
  if (v.valid_until && v.valid_until < v.valid_from) return "Berlaku sampai tidak boleh lebih awal dari tanggal mulai.";
  if (v.type.requires_work_scope && !v.work_scope.trim()) return "Jenis ini mensyaratkan lingkup pekerjaan.";
  return null;
}

export function authorizationErrorMessage(e: ApiError): string {
  switch (e.code) {
    case "SEPARATION_OF_DUTIES":
      return "Data yang Anda catat harus diverifikasi orang lain.";
    case "INVALID_STATE_TRANSITION":
      return e.details.some((d) => d.issue === "REVOKED")
        ? "Otorisasi sudah dicabut dan tidak dapat diubah. Ajukan otorisasi baru."
        : "Status sudah berubah. Muat ulang halaman.";
    case "WORK_SCOPE_REQUIRED":
      return "Jenis ini mensyaratkan lingkup pekerjaan.";
    case "VERSION_CONFLICT":
      return "Data diubah orang lain. Muat ulang lalu coba lagi.";
    case "REASON_REQUIRED":
      return "Alasan wajib diisi.";
    case "INVALID_DATE_RANGE":
      return "Tanggal akhir lebih awal dari tanggal mulai.";
    case "FILE_NOT_CLEAN":
      return "Dokumen belum lolos pemeriksaan. Unggah ulang.";
    case "DUPLICATE":
      return e.details.some((d) => d.field === "file_id") ? "Dokumen ini sudah dipakai otorisasi lain." : "Kode sudah dipakai.";
    case "FORBIDDEN":
    case "SCOPE_DENIED":
      return "Anda tidak berwenang untuk aksi ini.";
    case "NOT_FOUND":
      return "Data tidak ditemukan atau di luar cakupan Anda.";
    case "VALIDATION_ERROR":
      if (e.details.some((d) => d.issue === "in_future")) return "Tanggal mulai berlaku tidak boleh di masa depan.";
      return "Data tidak valid. Periksa kembali isian.";
    case "UNAVAILABLE":
      return "Server tidak dapat dihubungi. Coba lagi.";
    default:
      return "Permintaan gagal. Coba lagi.";
  }
}

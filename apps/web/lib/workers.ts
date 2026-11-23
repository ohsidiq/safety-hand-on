import type { ApiError } from "./api";
import { orgErrorMessage } from "./org";

/** Tipe pekerja (API-003 §2-§4). NIK tidak pernah ada di respons; hanya has_national_id. */
export type EmploymentStatus = "PERMANENT" | "CONTRACT" | "CONTRACTOR";
export type WorkerStatus = "ACTIVE" | "INACTIVE" | "SUSPENDED" | "RESIGNED";
export type Ref = { id: string; name: string | null } | null;

export interface WorkerSummary {
  id: string;
  sho_id: string;
  employee_number: string;
  full_name: string;
  employment_status: EmploymentStatus;
  worker_status: WorkerStatus;
  join_date: string;
  site: Ref;
  department: Ref;
  division: Ref;
  job_position: Ref;
  contractor: Ref;
  version: number;
}

export interface Worker extends WorkerSummary {
  phone: string | null;
  email: string | null;
  has_national_id: boolean;
  has_account: boolean;
  exit_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface Assignment {
  id: string;
  site: Ref;
  department: Ref;
  division: Ref;
  job_position: Ref;
  effective_from: string;
  effective_until: string | null;
  current: boolean;
  reason: string;
  created_at: string;
}

export interface ContractorOption {
  id: string;
  code: string;
  name: string;
  status: "ACTIVE" | "INACTIVE";
  site_ids: string[];
}

export const EMPLOYMENT_LABEL: Record<EmploymentStatus, string> = {
  PERMANENT: "Karyawan tetap",
  CONTRACT: "Karyawan kontrak",
  CONTRACTOR: "Pekerja kontraktor",
};

export const WORKER_STATUS_LABEL: Record<WorkerStatus, string> = {
  ACTIVE: "Aktif",
  SUSPENDED: "Diskors",
  INACTIVE: "Nonaktif",
  RESIGNED: "Berhenti",
};

export type StatusAction = "suspend" | "reinstate" | "deactivate" | "reactivate" | "resign";

/** Aksi status yang sah per status saat ini (API-003 §3). RESIGNED bersifat akhir. */
export const STATUS_ACTIONS: Record<WorkerStatus, { action: StatusAction; label: string }[]> = {
  ACTIVE: [
    { action: "suspend", label: "Skors" },
    { action: "deactivate", label: "Nonaktifkan" },
    { action: "resign", label: "Catat berhenti" },
  ],
  SUSPENDED: [
    { action: "reinstate", label: "Akhiri skorsing" },
    { action: "deactivate", label: "Nonaktifkan" },
    { action: "resign", label: "Catat berhenti" },
  ],
  INACTIVE: [
    { action: "reactivate", label: "Aktifkan kembali" },
    { action: "resign", label: "Catat berhenti" },
  ],
  RESIGNED: [],
};

/** Kontraktor yang boleh dipilih untuk Site: tanpa relasi Site (tidak dibatasi) atau terhubung ke Site itu (ER-013). */
export function contractorsForSite(list: ContractorOption[], siteId: string): ContractorOption[] {
  return list.filter((c) => c.status === "ACTIVE" && (c.site_ids.length === 0 || c.site_ids.includes(siteId)));
}

const PHONE_RE = /^\+[1-9]\d{7,14}$/;
const EMP_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,29}$/;

/** Validasi di klien sama dengan API-003 §9 (server tetap memeriksa). Mengembalikan pesan atau null. */
export function validateWorkerInput(v: {
  employee_number?: string;
  full_name?: string;
  phone?: string;
  email?: string;
  national_id?: string;
}): string | null {
  if (v.employee_number !== undefined && !EMP_RE.test(v.employee_number.trim()))
    return "Nomor pekerja wajib 3 sampai 30 karakter: huruf, angka, titik, garis miring, atau tanda hubung.";
  if (v.full_name !== undefined && (v.full_name.trim().length < 2 || v.full_name.trim().length > 150))
    return "Nama wajib 2 sampai 150 karakter.";
  if (v.phone && !PHONE_RE.test(v.phone.trim())) return "Nomor telepon memakai format internasional, mis. +6281234567890.";
  if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) return "Format email tidak valid.";
  if (v.national_id && !/^\d{16}$/.test(v.national_id.replace(/[\s-]/g, ""))) return "NIK harus 16 digit angka.";
  return null;
}

/** Pesan galat pekerja untuk pengguna (API-003 §10). NIK tidak pernah disebut nilainya. */
export function workerErrorMessage(e: ApiError): string {
  const field = e.details[0]?.field;
  const issue = e.details[0]?.issue;
  switch (e.code) {
    case "DUPLICATE":
      if (field === "national_id") return "NIK sudah terdaftar pada pekerja lain di perusahaan ini.";
      return "Nomor pekerja sudah dipakai. Gunakan nomor lain.";
    case "CONTRACTOR_REQUIRED":
      return "Pekerja kontraktor wajib memilih kontraktor.";
    case "CONTRACTOR_NOT_ALLOWED":
      return "Kontraktor hanya diisi untuk pekerja kontraktor.";
    case "SITE_NOT_LINKED_TO_CONTRACTOR":
      return "Site ini tidak terhubung ke kontraktor pekerja. Pilih Site lain atau kontraktor lain.";
    case "DEPARTMENT_NOT_IN_SITE":
      return "Department bukan milik Site yang dipilih.";
    case "REASON_REQUIRED":
      return "Alasan wajib diisi (minimal 3 karakter).";
    case "INVALID_STATE_TRANSITION":
      return issue === "resigned_is_final" || issue === "from_RESIGNED"
        ? "Pekerja yang sudah berhenti tidak dapat diubah."
        : "Aksi ini tidak sesuai status pekerja saat ini. Muat ulang halaman.";
    case "ASSIGNMENT_OVERLAP":
      return "Tanggal berlaku harus setelah tanggal mulai penempatan saat ini.";
    case "SERVICE_UNAVAILABLE":
      if (field === "national_id") return "Penyimpanan NIK belum diaktifkan. Simpan tanpa NIK dulu, lalu isi NIK nanti.";
      return "Layanan sementara tidak tersedia. Coba lagi.";
    case "VALIDATION_ERROR":
      if (field === "national_id") return "NIK harus 16 digit angka.";
      if (field === "join_date") return "Tanggal masuk tidak boleh lebih dari 1 hari ke depan.";
      if (field === "effective_from" && issue === "future_not_supported_yet")
        return "Penempatan bertanggal mendatang belum didukung. Pakai tanggal hari ini atau sebelumnya.";
      if (field === "exit_date") return "Tanggal berhenti wajib diisi dan tidak boleh sebelum tanggal masuk.";
      if (field === "division_id") return "Divisi bukan milik department yang dipilih.";
      if (issue === "inactive") return "Site, department, divisi, atau posisi yang dipilih sudah nonaktif.";
      if (issue === "reference_not_found")
        return "Site, department, posisi, atau kontraktor tidak ditemukan atau di luar cakupan Anda.";
      return "Data tidak valid. Periksa kembali isian.";
    default:
      return orgErrorMessage(e);
  }
}

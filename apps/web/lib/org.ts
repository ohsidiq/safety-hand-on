import type { ApiError } from "./api";

/** Tipe struktur organisasi (API-002 §4-§6). */
export type OrgStatus = "ACTIVE" | "INACTIVE";

interface Meta {
  id: string;
  name: string;
  code: string;
  status: OrgStatus;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Site extends Meta {
  location: string | null;
  timezone: string;
}
export interface Department extends Meta {
  site_id: string;
}
export interface Division extends Meta {
  site_id: string;
  department_id: string;
}
export interface Team extends Meta {
  site_id: string;
  department_id: string | null;
}
export interface JobPosition extends Meta {
  job_family: string | null;
  description: string | null;
}
export interface EquipmentClass extends Meta {
  description: string | null;
}
export interface TeamMember {
  worker_id: string;
  full_name: string | null;
  sho_id: string | null;
  valid_from: string;
  valid_until: string | null;
  active: boolean;
}

/** Zona waktu Indonesia (IANA) untuk pilihan cepat; nilai lain tetap diterima API bila valid (ORG-API-006). */
export const ID_TIMEZONES = [
  { value: "Asia/Jakarta", label: "WIB (Asia/Jakarta)" },
  { value: "Asia/Pontianak", label: "WIB (Asia/Pontianak)" },
  { value: "Asia/Makassar", label: "WITA (Asia/Makassar)" },
  { value: "Asia/Jayapura", label: "WIT (Asia/Jayapura)" },
];

export const STATUS_LABEL: Record<OrgStatus, string> = { ACTIVE: "Aktif", INACTIVE: "Nonaktif" };

const CODE_RE = /^[A-Z0-9][A-Z0-9-]{1,29}$/;

/** Validasi di klien sama dengan API-002 §10 (server tetap memeriksa). Mengembalikan pesan atau null. */
export function validateNameCode(name: string, code: string): string | null {
  const n = name.trim();
  if (n.length < 2 || n.length > 150) return "Nama wajib 2 sampai 150 karakter.";
  if (!CODE_RE.test(code)) return "Kode wajib 2 sampai 30 karakter: huruf besar, angka, dan tanda hubung.";
  return null;
}

/** Kode dari input bebas: huruf besar, spasi menjadi tanda hubung. */
export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/\s+/g, "-")
    .replace(/[^A-Z0-9-]/g, "");
}

const IN_USE: Record<string, (n: number | null) => string> = {
  ACTIVE_WORKERS_EXIST: (n) =>
    `Tidak dapat dinonaktifkan: masih ada ${n ?? "beberapa"} pekerja aktif. Pindahkan pekerja lebih dulu.`,
  POSITION_IN_USE: (n) => `Tidak dapat dinonaktifkan: posisi masih dipakai ${n ?? "beberapa"} pekerja aktif.`,
  ACTIVE_MEMBERS_EXIST: (n) =>
    `Tidak dapat dinonaktifkan: tim masih memiliki ${n ?? "beberapa"} anggota aktif. Akhiri keanggotaan lebih dulu.`,
};

/** Pesan galat untuk pengguna (UIUX-005 §3). Tidak menampilkan detail teknis. */
export function orgErrorMessage(e: ApiError): string {
  const issue = e.details[0]?.issue;
  const field = e.details[0]?.field;
  switch (e.code) {
    case "DUPLICATE":
      return "Kode sudah dipakai di cakupan yang sama. Gunakan kode lain.";
    case "VERSION_CONFLICT":
      return "Data sudah diubah orang lain. Muat ulang lalu coba lagi.";
    case "FORBIDDEN":
    case "SCOPE_DENIED":
      return "Anda tidak berwenang mengubah data ini.";
    case "NOT_FOUND":
      return "Data tidak ditemukan atau di luar cakupan Anda.";
    case "CONFLICT": {
      const n = typeof e.extra.affected_workers === "number" ? e.extra.affected_workers : null;
      if (issue && IN_USE[issue]) return (IN_USE[issue] as (n: number | null) => string)(n);
      if (issue === "MEMBERSHIP_OVERLAP") return "Pekerja sudah menjadi anggota tim ini pada rentang tanggal tersebut.";
      if (issue === "TEAM_INACTIVE") return "Tim nonaktif tidak dapat menerima anggota baru.";
      if (issue === "already_INACTIVE") return "Data sudah nonaktif.";
      if (issue === "already_ACTIVE") return "Data sudah aktif.";
      return "Perubahan bertentangan dengan keadaan data saat ini.";
    }
    case "VALIDATION_ERROR":
      if (field === "timezone") return "Zona waktu tidak valid. Pilih zona waktu IANA, mis. Asia/Makassar.";
      if (issue === "WORKER_SITE_MISMATCH") return "Pekerja tidak ditempatkan di Site tim ini.";
      if (field === "valid_until") return "Tanggal berakhir tidak boleh sebelum tanggal mulai.";
      return "Data tidak valid. Periksa nama (2-150 karakter) dan kode (huruf besar, angka, tanda hubung).";
    case "UNAVAILABLE":
      return "Layanan tidak dapat dihubungi. Periksa koneksi lalu coba lagi.";
    default:
      return "Perubahan tidak dapat disimpan. Coba lagi.";
  }
}

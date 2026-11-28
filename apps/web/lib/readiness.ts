import type { ApiError } from "./api";

/**
 * Readiness (API-014, SRS-RE, B-02, B-30). Status dihitung server; layar hanya menampilkan. Item medis yang tidak terpenuhi
 * sudah disamarkan server ("Syarat Medical belum terpenuhi") untuk peran selain Medical Officer, Dokter, dan pekerja sendiri.
 */
export type ReadinessStatus = "READY" | "CONDITIONAL" | "NOT_READY";
export type ItemType = "COMPETENCY" | "MEDICAL" | "AUTHORIZATION" | "SIMPER";
export type RequirementStatus =
  | "VALID"
  | "EXPIRING_SOON"
  | "EXPIRED"
  | "MISSING"
  | "PENDING_VERIFICATION"
  | "REJECTED"
  | "SUSPENDED"
  | "RESTRICTED"
  | "NOT_MET";

export interface ReadinessItem {
  profile_item_id: string;
  item_type: ItemType;
  requirement_name: string;
  requirement_status: RequirementStatus;
  is_mandatory: boolean;
  expiry_date: string | null;
  reason_code: string;
  masked: boolean;
}

export interface WorkerReadiness {
  worker_id: string;
  snapshot_id: string;
  status: ReadinessStatus;
  score: number;
  reason_code: "WORKER_INACTIVE" | "PROFILE_NOT_SET" | null;
  evaluated_at: string;
  next_evaluation_at: string | null;
  trigger_type: string;
  rule_version: string;
  profile: { id: string; version: number } | null;
  items: ReadinessItem[];
}

export interface ReadinessSnapshot {
  id: string;
  status: ReadinessStatus;
  previous_status: ReadinessStatus | null;
  score: number;
  reason_code: string | null;
  profile_version: number | null;
  trigger_type: string;
  evaluated_at: string;
}

export interface ProfileItem {
  id: string;
  item_type: ItemType;
  requirement_name: string;
  competency_id: string | null;
  medical_exam_type_id: string | null;
  authorization_type_id: string | null;
  simper_type_id: string | null;
  equipment_class_id: string | null;
  is_mandatory: boolean;
  warning_days: number;
  display_order: number;
}

export interface RequirementProfile {
  id: string;
  job_position: { id: string; name: string; code: string };
  profile_version: number;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  effective_from: string | null;
  notes: string | null;
  activated_at: string | null;
  item_count: number;
  version: number;
  created_at: string;
  items?: ProfileItem[];
}

export const STATUS_LABEL: Record<ReadinessStatus, string> = {
  READY: "Siap",
  CONDITIONAL: "Siap bersyarat",
  NOT_READY: "Tidak siap",
};

export const STATUS_BADGE: Record<ReadinessStatus, string> = {
  READY: "badge-success",
  CONDITIONAL: "badge-warning",
  NOT_READY: "badge-denied",
};

export const REASON_LABEL: Record<"WORKER_INACTIVE" | "PROFILE_NOT_SET", string> = {
  WORKER_INACTIVE: "Pekerja tidak aktif.",
  PROFILE_NOT_SET: "Jabatan pekerja belum memiliki daftar syarat aktif.",
};

export const ITEM_TYPE_LABEL: Record<ItemType, string> = {
  COMPETENCY: "Kompetensi",
  MEDICAL: "Medical",
  AUTHORIZATION: "Otorisasi Kerja",
  SIMPER: "SIMPER",
};

export const REQUIREMENT_STATUS_LABEL: Record<RequirementStatus, string> = {
  VALID: "Berlaku",
  EXPIRING_SOON: "Segera berakhir",
  EXPIRED: "Kedaluwarsa",
  MISSING: "Belum ada",
  PENDING_VERIFICATION: "Menunggu verifikasi",
  REJECTED: "Ditolak",
  SUSPENDED: "Dibekukan",
  RESTRICTED: "Dengan pembatasan",
  NOT_MET: "Belum terpenuhi",
};

export const TRIGGER_LABEL: Record<string, string> = {
  EVENT: "Perubahan data",
  SCHEDULED: "Terjadwal",
  MANUAL: "Nilai ulang manual",
  PROFILE_CHANGE: "Perubahan daftar syarat",
  RULE_CHANGE: "Perubahan aturan",
};

export const PROFILE_STATUS_LABEL: Record<RequirementProfile["status"], string> = {
  DRAFT: "Draf",
  ACTIVE: "Aktif",
  ARCHIVED: "Arsip",
};

/** Kelas lencana per status syarat. */
export function requirementBadge(s: RequirementStatus): string {
  if (s === "VALID") return "badge-success";
  if (s === "EXPIRING_SOON" || s === "RESTRICTED") return "badge-warning";
  return "badge-denied";
}

/** Teks status syarat; item medis tersamar memakai kalimat baku PB-009. */
export function requirementText(i: ReadinessItem): string {
  if (i.masked) return "Syarat Medical belum terpenuhi";
  return REQUIREMENT_STATUS_LABEL[i.requirement_status] ?? i.requirement_status;
}

/** Baris syarat pada formulir draf. `ref` = id master sesuai jenis; `classId` hanya SIMPER. */
export interface DraftItem {
  /** Kunci baris di layar (bukan dikirim ke server). */
  uid: string;
  item_type: ItemType;
  ref: string;
  classId: string;
  is_mandatory: boolean;
  warning_days: string;
}

const REF_FIELD: Record<ItemType, string> = {
  COMPETENCY: "competency_id",
  MEDICAL: "medical_exam_type_id",
  AUTHORIZATION: "authorization_type_id",
  SIMPER: "simper_type_id",
};

export function draftFromProfile(items: ProfileItem[] = []): DraftItem[] {
  return items.map((i) => ({
    uid: i.id,
    item_type: i.item_type,
    ref: (i[REF_FIELD[i.item_type] as keyof ProfileItem] as string | null) ?? "",
    classId: i.equipment_class_id ?? "",
    is_mandatory: i.is_mandatory,
    warning_days: String(i.warning_days),
  }));
}

let rowSeq = 0;
/** Baris syarat kosong baru (Kompetensi, wajib, peringatan 30 hari). */
export function emptyDraftItem(): DraftItem {
  rowSeq += 1;
  return { uid: `baru-${rowSeq}`, item_type: "COMPETENCY", ref: "", classId: "", is_mandatory: true, warning_days: "30" };
}

/** Validasi di klien (server tetap memeriksa). Mengembalikan pesan pertama atau null. */
export function validateDraft(items: DraftItem[]): string | null {
  const seen = new Set<string>();
  for (const [n, it] of items.entries()) {
    const row = `Syarat ke-${n + 1}`;
    if (!it.ref) return `${row}: pilih ${ITEM_TYPE_LABEL[it.item_type].toLowerCase()} yang disyaratkan.`;
    const days = Number(it.warning_days);
    if (it.warning_days.trim() === "" || !Number.isInteger(days) || days < 0 || days > 365)
      return `${row}: hari peringatan 0 sampai 365.`;
    const key = `${it.item_type}:${it.ref}:${it.item_type === "SIMPER" ? it.classId : ""}`;
    if (seen.has(key)) return `${row}: syarat yang sama sudah ada.`;
    seen.add(key);
  }
  return null;
}

/** Bentuk isi permintaan API dari baris formulir. */
export function draftPayload(items: DraftItem[]) {
  return items.map((it) => ({
    item_type: it.item_type,
    [REF_FIELD[it.item_type]]: it.ref,
    ...(it.item_type === "SIMPER" && it.classId ? { equipment_class_id: it.classId } : {}),
    is_mandatory: it.is_mandatory,
    warning_days: Number(it.warning_days),
  }));
}

export function readinessErrorMessage(e: ApiError): string {
  switch (e.code) {
    case "PROFILE_EMPTY":
      return "Tambahkan minimal satu syarat sebelum mengaktifkan.";
    case "PROFILE_NOT_DRAFT":
      return "Daftar syarat aktif atau arsip tidak dapat diubah. Buat versi baru.";
    case "POSITION_HAS_ACTIVE_PROFILE":
      return "Jabatan ini sudah memiliki daftar syarat. Gunakan Buat versi baru.";
    case "CONFLICT":
      return "Jabatan ini sudah memiliki draf. Lanjutkan draf yang ada.";
    case "DUPLICATE":
      return "Ada syarat yang sama lebih dari sekali.";
    case "ITEM_TYPE_NOT_AVAILABLE":
      return "Jenis syarat ini belum tersedia.";
    case "INVALID_REQUIREMENT_REFERENCE":
      return "Pilihan syarat tidak valid atau sudah tidak ada.";
    case "VERSION_CONFLICT":
      return "Data diubah orang lain. Muat ulang lalu coba lagi.";
    case "FORBIDDEN":
    case "SCOPE_DENIED":
      return "Anda tidak berwenang melakukan ini.";
    case "NOT_FOUND":
      return "Data tidak ditemukan atau di luar cakupan Anda.";
    case "VALIDATION_ERROR":
      return "Isian tidak valid. Periksa kembali.";
    default:
      return "Permintaan gagal. Coba lagi.";
  }
}

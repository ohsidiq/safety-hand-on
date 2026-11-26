import type { ApiError } from "./api";
import { type AuthValidity, authorizationErrorMessage, type SuspensionStatus } from "./authorizations";

/** SIMPER (API-007) dan otorisasi per kelas alat. validity_status hanya informasi (penentu: Readiness Engine). */
export interface SimperType {
  id: string;
  name: string;
  code: string;
  description: string | null;
  default_validity_months: number | null;
  status: "ACTIVE" | "INACTIVE";
  version: number;
}

export type ClassAuthStatus = "ACTIVE" | "SUSPENDED" | "REVOKED";

export interface SimperClassAuth {
  id: string;
  simper_id: string;
  equipment_class: { id: string; name: string | null; code: string | null };
  valid_from: string;
  valid_until: string | null;
  restriction_note: string | null;
  status: ClassAuthStatus;
  status_reason: string | null;
  version: number;
}

export interface Simper {
  id: string;
  worker_id: string;
  worker_name: string | null;
  sho_id: string | null;
  simper_type: { id: string; name: string | null; code: string | null };
  simper_number: string | null;
  issuer: string | null;
  restriction_note: string | null;
  valid_from: string;
  valid_until: string | null;
  has_document: boolean;
  verification_status: "PENDING" | "VERIFIED" | "REJECTED";
  suspension_status: SuspensionStatus;
  validity_status: AuthValidity;
  verified_by_name: string | null;
  rejection_reason: string | null;
  suspended_by_name: string | null;
  suspension_reason: string | null;
  created_by_name: string | null;
  updated_at: string;
  version: number;
  can_verify: boolean;
  equipment_authorizations: SimperClassAuth[];
}

export const CLASS_AUTH_LABEL: Record<ClassAuthStatus, string> = {
  ACTIVE: "Aktif",
  SUSPENDED: "Dibekukan",
  REVOKED: "Dicabut",
};

/** Aksi status otorisasi kelas alat yang sah (BR-WF006-015/016). */
export function classAuthActions(s: ClassAuthStatus): ("suspend" | "reinstate" | "revoke")[] {
  if (s === "ACTIVE") return ["suspend", "revoke"];
  if (s === "SUSPENDED") return ["reinstate", "revoke"];
  return [];
}

/** Ringkasan kelas alat yang masih aktif, untuk tabel ("Dump Truck, Excavator"). */
export function activeClasses(s: Pick<Simper, "equipment_authorizations">): string {
  const names = s.equipment_authorizations.filter((a) => a.status === "ACTIVE").map((a) => a.equipment_class.name ?? "-");
  return names.length ? names.join(", ") : "Tidak ada kelas alat aktif";
}

export interface ClassAuthInput {
  valid_from: string;
  valid_until: string;
}

/** Otorisasi kelas alat harus di dalam masa berlaku SIMPER induk (sama dengan pemeriksaan server). */
export function classAuthWithinSimper(a: ClassAuthInput, simper: { valid_from: string; valid_until: string }): string | null {
  if (!a.valid_from) return "Tanggal mulai otorisasi kelas alat wajib diisi.";
  if (a.valid_until && a.valid_until < a.valid_from) return "Tanggal akhir otorisasi lebih awal dari tanggal mulai.";
  if (a.valid_from < simper.valid_from) return "Otorisasi kelas alat tidak boleh mulai sebelum SIMPER berlaku.";
  if (simper.valid_until && (!a.valid_until || a.valid_until > simper.valid_until))
    return "Otorisasi kelas alat tidak boleh berakhir setelah SIMPER berakhir.";
  return null;
}

export function simperErrorMessage(e: ApiError): string {
  if (e.code === "AUTHORIZATION_OUTSIDE_SIMPER_VALIDITY") return "Otorisasi kelas alat harus berada dalam masa berlaku SIMPER.";
  if (e.code === "DUPLICATE" && e.details.some((d) => d.field === "equipment_class_id"))
    return "Kelas alat ini sudah memiliki otorisasi pada SIMPER tersebut.";
  if (e.code === "INVALID_STATE_TRANSITION" && e.details.some((d) => d.issue === "REVOKED"))
    return "Sudah dicabut dan tidak dapat diubah. Ajukan yang baru.";
  return authorizationErrorMessage(e);
}

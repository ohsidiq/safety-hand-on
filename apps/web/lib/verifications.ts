import type { WorkerAuthorization } from "./authorizations";
import type { WorkerCompetency } from "./competencies";
import type { MedicalRecord } from "./medical";
import type { Simper } from "./simpers";

/**
 * Antrean verifikasi gabungan (M3.6b, UIUX-005 §6.2): gabungan antrean Kompetensi, Otorisasi Kerja, SIMPER, dan
 * penetapan MCU yang dapat diverifikasi pengguna, diurutkan dari yang paling lama menunggu.
 * Data diambil dari endpoint antrean tiap modul, jadi scope, pemisahan tugas (can_verify / can_determine) dan formulir
 * verifikasi tetap satu sumber di modul masing-masing.
 */
export type QueueKind = "COMPETENCY" | "AUTHORIZATION" | "SIMPER" | "MEDICAL";

export const QUEUE_SOURCES: { kind: QueueKind; label: string; permission: string; path: string; page: string }[] = [
  {
    kind: "COMPETENCY",
    label: "Kompetensi",
    permission: "competency.verify",
    path: "/competencies/pending-verification",
    page: "/competencies",
  },
  {
    kind: "AUTHORIZATION",
    label: "Otorisasi Kerja",
    permission: "authorization.verify",
    path: "/authorizations/pending-verification",
    page: "/authorizations",
  },
  { kind: "SIMPER", label: "SIMPER", permission: "simper.verify", path: "/simpers/pending-verification", page: "/simpers" },
  {
    kind: "MEDICAL",
    label: "MCU (Fit to Work)",
    permission: "medical.verify",
    path: "/medical-records/pending-determination",
    page: "/medical",
  },
];

/** Batas per modul yang diambil; bila tercapai, halaman modul menampilkan sisanya. */
export const QUEUE_PAGE_LIMIT = 100;

export type QueueRaw =
  | { kind: "COMPETENCY"; item: WorkerCompetency }
  | { kind: "AUTHORIZATION"; item: WorkerAuthorization }
  | { kind: "SIMPER"; item: Simper }
  | { kind: "MEDICAL"; item: MedicalRecord };

export interface QueueEntry {
  key: string;
  kind: QueueKind;
  id: string;
  workerId: string;
  workerName: string | null;
  shoId: string | null;
  itemName: string;
  submittedAt: string;
  waitingDays: number;
  /** Pengguna tidak boleh memverifikasi (pembuat record, pemisahan tugas). */
  mine: boolean;
  raw: QueueRaw;
}

export interface QueueSources {
  COMPETENCY?: WorkerCompetency[];
  AUTHORIZATION?: WorkerAuthorization[];
  SIMPER?: Simper[];
  MEDICAL?: MedicalRecord[];
}

const DAY = 24 * 60 * 60 * 1000;

function entry(raw: QueueRaw, itemName: string, canAct: boolean, now: number): QueueEntry {
  const it = raw.item;
  const submitted = Date.parse(it.updated_at);
  return {
    key: `${raw.kind}:${it.id}`,
    kind: raw.kind,
    id: it.id,
    workerId: it.worker_id,
    workerName: it.worker_name,
    shoId: it.sho_id,
    itemName,
    submittedAt: it.updated_at,
    waitingDays: Number.isFinite(submitted) ? Math.max(0, Math.floor((now - submitted) / DAY)) : 0,
    mine: !canAct,
    raw,
  };
}

/** Menggabungkan antrean modul menjadi satu daftar, terlama dahulu (urutan stabil: waktu, lalu jenis, lalu id). */
export function mergeQueue(src: QueueSources, now: number = Date.now()): QueueEntry[] {
  const out: QueueEntry[] = [];
  for (const it of src.COMPETENCY ?? [])
    out.push(entry({ kind: "COMPETENCY", item: it }, it.competency.name ?? "-", it.can_verify, now));
  for (const it of src.AUTHORIZATION ?? [])
    out.push(entry({ kind: "AUTHORIZATION", item: it }, it.authorization_type.name ?? "-", it.can_verify, now));
  for (const it of src.SIMPER ?? [])
    out.push(entry({ kind: "SIMPER", item: it }, it.simper_type.name ?? "-", it.can_verify, now));
  for (const it of src.MEDICAL ?? [])
    out.push(entry({ kind: "MEDICAL", item: it }, it.exam_type.name ?? "-", it.can_determine, now));
  const order: Record<QueueKind, number> = { COMPETENCY: 0, AUTHORIZATION: 1, SIMPER: 2, MEDICAL: 3 };
  return out.sort(
    (a, b) => a.submittedAt.localeCompare(b.submittedAt) || order[a.kind] - order[b.kind] || a.id.localeCompare(b.id),
  );
}

/** Label lama menunggu; lebih dari 3 hari ditandai agar terlihat (UIUX-005 §6.2 terlama dahulu). */
export function waitingLabel(days: number): { text: string; overdue: boolean } {
  if (days <= 0) return { text: "hari ini", overdue: false };
  return { text: `${days} hari`, overdue: days > 3 };
}

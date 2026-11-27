"use client";

import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { apiGet, apiSend } from "@/lib/api";
import { uploadFile } from "@/lib/files";
import {
  CLEARANCE_CHECKLIST,
  type ClearanceChecklistKey,
  FITNESS_LABEL,
  FITNESS_OPTIONS,
  type Fitness,
  MEDICAL_VALIDITY_BADGE,
  MEDICAL_VALIDITY_LABEL,
  type MedicalClearance,
  type MedicalClearanceType,
  type MedicalExamType,
  type MedicalRecord,
  type MedicalStatus,
  MIN_ACCESS_REASON,
  medicalErrorMessage,
  RESTRICTION_CODES,
  validateClearance,
  validateDetermination,
} from "@/lib/medical";
import { useSession } from "@/lib/session";

const localToday = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const plusMonths = (from: string, m: number) => {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + m);
  return d.toISOString().slice(0, 10);
};

/** Ringkasan status medis (tingkat status): tanpa dokumen, penyedia, atau jenis pemeriksaan. */
export function MedicalStatusView({ status }: { status: MedicalStatus }) {
  return (
    <div className="stack">
      <p>
        <span className={MEDICAL_VALIDITY_BADGE[status.validity_status]}>{MEDICAL_VALIDITY_LABEL[status.validity_status]}</span>
        {status.fitness_status ? ` · ${FITNESS_LABEL[status.fitness_status]}` : ""}
        {status.expiry_date ? ` · berlaku s.d. ${status.expiry_date}` : ""}
        {status.unfit_until ? ` · tinjau ulang ${status.unfit_until}` : ""}
        {status.follow_up_due ? ` · tindak lanjut s.d. ${status.follow_up_due}` : ""}
      </p>
      {status.restrictions.length > 0 ? (
        <>
          <p className="small-text">Pembatasan operasional:</p>
          <ul>
            {status.restrictions.map((r) => (
              <li key={r.id}>
                {r.operational_description}
                {r.valid_until ? ` (s.d. ${r.valid_until})` : ""}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {status.has_pending ? <p className="muted small-text">Ada MCU yang menunggu penetapan Dokter.</p> : null}
    </div>
  );
}

/**
 * Bagian Medical di detail pekerja / profil (UIUX WF004).
 * - canStatus: medical.read_status (status + pembatasan operasional saja).
 * - canRecord: medical.update penuh atau LIMITED (pencatatan administratif, tanpa penetapan).
 * - canDetail: medical.read_detail (Dokter, Medical Officer; HSE Manager hanya bila ada otorisasi tercatat).
 * - canDetermine: medical.verify (Dokter). canClearance: medical.clearance (Dokter, pemeriksaan kesiapan kerja khusus).
 * - self: pekerja membaca miliknya (tanpa alasan akses).
 */
export function MedicalSection({
  workerId,
  canStatus,
  canRecord,
  canDetail,
  canDetermine,
  canClearance = false,
  self = false,
  title = "Medical",
}: {
  workerId: string;
  canStatus: boolean;
  canRecord: boolean;
  canDetail: boolean;
  canDetermine: boolean;
  canClearance?: boolean;
  self?: boolean;
  title?: string;
}) {
  const { getToken } = useSession();
  const id = useId();
  const [status, setStatus] = useState<MedicalStatus | null>(null);
  const [records, setRecords] = useState<MedicalRecord[] | null>(null);
  const [reason, setReason] = useState("");
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    if (!canStatus) return;
    const token = await getToken();
    if (!token) return;
    const r = await apiGet<MedicalStatus>(`/workers/${workerId}/medical-status`, token);
    if (r.ok) setStatus(r.data);
  }, [canStatus, getToken, workerId]);
  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const openDetail = useCallback(
    async (why: string) => {
      setError(null);
      const token = await getToken();
      if (!token) return;
      const r = await apiGet<MedicalRecord[]>(
        `/workers/${workerId}/medical-records`,
        token,
        fetch,
        self ? {} : { "X-Access-Reason": why.trim() },
      );
      if (!r.ok)
        return setError(
          r.code === "ACCESS_REASON_REQUIRED"
            ? `Isi alasan akses (minimal ${MIN_ACCESS_REASON} karakter).`
            : "Detail medis tidak dapat dibuka.",
        );
      setRecords(r.data);
    },
    [getToken, workerId, self],
  );
  useEffect(() => {
    if (self && canDetail) void openDetail("");
  }, [self, canDetail, openDetail]);

  const changed = (text: string) => {
    setMessage(text);
    setAdding(false);
    void loadStatus();
    if (records) void openDetail(reason);
  };

  return (
    <section className="card panel" aria-labelledby={`medis-${workerId}`}>
      <h2 id={`medis-${workerId}`}>{title}</h2>
      {message ? <p role="status">{message}</p> : null}
      {status ? <MedicalStatusView status={status} /> : canStatus ? <p role="status">Memuat…</p> : null}
      {canStatus || canClearance ? (
        <ClearancePanel workerId={workerId} canIssue={canClearance} onChanged={(t) => setMessage(t)} />
      ) : null}
      {canDetail && !self && records === null ? (
        <form
          className="form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (reason.trim().length < MIN_ACCESS_REASON)
              return setError(`Isi alasan akses (minimal ${MIN_ACCESS_REASON} karakter).`);
            void openDetail(reason);
          }}
        >
          <p className="muted small-text">Membuka detail medis tercatat di Jejak Audit beserta alasannya.</p>
          <label htmlFor={`${id}-reason`}>
            Alasan akses detail
            <input id={`${id}-reason`} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button type="submit" className="secondary">
            Buka detail medis
          </button>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {records ? (
        <>
          <h3>Riwayat MCU</h3>
          {records.length === 0 ? <p className="muted">Belum ada record MCU.</p> : null}
          <ul className="stack">
            {records.map((r) => (
              <MedicalRecordItem
                key={r.id}
                record={r}
                reason={self ? "" : reason}
                self={self}
                canDetermine={canDetermine}
                onChanged={changed}
              />
            ))}
          </ul>
        </>
      ) : null}
      {canRecord && !adding ? (
        <p>
          <button type="button" onClick={() => setAdding(true)}>
            Catat MCU
          </button>
        </p>
      ) : null}
      {adding ? <AddMedicalRecord workerId={workerId} onDone={changed} onCancel={() => setAdding(false)} /> : null}
    </section>
  );
}

export function MedicalRecordItem({
  record,
  reason,
  self,
  canDetermine,
  onChanged,
}: {
  record: MedicalRecord;
  reason: string;
  self: boolean;
  canDetermine: boolean;
  onChanged: (t: string) => void;
}) {
  const { getToken } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "determine" | "reject" | "grant">("view");
  const openDoc = async () => {
    const token = await getToken();
    if (!token) return;
    const r = await apiGet<{ url: string }>(
      `/medical-records/${record.id}/document-url`,
      token,
      fetch,
      self ? {} : { "X-Access-Reason": reason },
    );
    if (!r.ok) return setError("Dokumen tidak dapat dibuka.");
    window.open(r.data.url, "_blank", "noopener,noreferrer");
  };
  return (
    <li>
      <strong>{record.exam_type.name}</strong> · diperiksa {record.examination_date} · berlaku s.d. {record.expiry_date}
      {record.provider ? ` · ${record.provider}` : ""}
      <br />
      {record.verification_status === "VERIFIED" && record.fitness_status ? (
        <>
          {FITNESS_LABEL[record.fitness_status]} (ditetapkan {record.verified_by_name ?? "-"})
          {record.unfit_until ? ` · tinjau ulang ${record.unfit_until}` : ""}
          {record.follow_up_note ? ` · tindak lanjut: ${record.follow_up_note} (s.d. ${record.follow_up_due})` : ""}
        </>
      ) : record.verification_status === "REJECTED" ? (
        <>Ditolak: {record.rejection_reason}</>
      ) : (
        <span className="muted">Menunggu penetapan Dokter</span>
      )}
      {record.restrictions.filter((x) => x.status === "ACTIVE").length > 0 ? (
        <ul>
          {record.restrictions
            .filter((x) => x.status === "ACTIVE")
            .map((x) => (
              <li key={x.id}>{x.operational_description}</li>
            ))}
        </ul>
      ) : null}{" "}
      {record.has_document ? (
        <button type="button" className="secondary" onClick={() => void openDoc()}>
          Buka dokumen MCU
        </button>
      ) : null}
      {canDetermine && record.can_determine && mode === "view" ? (
        <span className="row-actions">
          <button type="button" onClick={() => setMode("determine")}>
            Tetapkan Fit to Work
          </button>
          <button type="button" className="secondary" onClick={() => setMode("reject")}>
            Tolak
          </button>
        </span>
      ) : null}
      {canDetermine && mode === "view" ? (
        <button type="button" className="secondary" onClick={() => setMode("grant")}>
          Beri akses HSE Manager
        </button>
      ) : null}
      {canDetermine && record.verification_status === "PENDING" && !record.can_determine ? (
        <p className="muted small-text">Record yang Anda catat ditetapkan Dokter lain.</p>
      ) : null}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {mode === "determine" ? (
        <DeterminationForm record={record} onDone={(t) => onChanged(t)} onCancel={() => setMode("view")} />
      ) : null}
      {mode === "reject" ? <RejectForm record={record} onDone={(t) => onChanged(t)} onCancel={() => setMode("view")} /> : null}
      {mode === "grant" ? <GrantForm recordId={record.id} onDone={(t) => onChanged(t)} onCancel={() => setMode("view")} /> : null}
    </li>
  );
}

export function DeterminationForm({
  record,
  onDone,
  onCancel,
}: {
  record: MedicalRecord;
  onDone: (t: string) => void;
  onCancel: () => void;
}) {
  const { getToken } = useSession();
  const id = useId();
  const [form, setForm] = useState({
    fitness: "" as Fitness | "",
    unfit_until: "",
    follow_up_note: "",
    follow_up_due: "",
    restriction_code: "",
    restriction_until: "",
    comment: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const bad = validateDetermination(form, localToday());
    if (bad) return setError(bad);
    setBusy(true);
    const token = await getToken();
    if (!token) return;
    const code = RESTRICTION_CODES.find((x) => x.code === form.restriction_code);
    const r = await apiSend(
      "POST",
      `/medical-records/${record.id}/determination`,
      token,
      {
        fitness_status: form.fitness,
        unfit_until: form.fitness === "UNFIT" && form.unfit_until ? form.unfit_until : null,
        ...(form.fitness === "FIT_WITH_CONDITION"
          ? { follow_up_note: form.follow_up_note.trim(), follow_up_due: form.follow_up_due }
          : {}),
        restrictions:
          form.fitness === "FIT_WITH_RESTRICTION" && code
            ? [
                {
                  restriction_code: code.code,
                  operational_description: code.description,
                  valid_from: localToday(),
                  valid_until: form.restriction_until || null,
                },
              ]
            : [],
        comment: form.comment.trim() || undefined,
      },
      { ifMatch: record.version },
    );
    setBusy(false);
    if (!r.ok) return setError(medicalErrorMessage(r.error));
    onDone("Fit to Work ditetapkan.");
  };
  return (
    <form className="form" onSubmit={submit} aria-label="Penetapan Fit to Work">
      <fieldset>
        <legend>Hasil penetapan Dokter (wajib)</legend>
        {FITNESS_OPTIONS.map((o) => (
          <label key={o.value} htmlFor={`${id}-fit-${o.value}`} className="check">
            <input
              id={`${id}-fit-${o.value}`}
              type="radio"
              name={`${id}-fit`}
              value={o.value}
              checked={form.fitness === o.value}
              onChange={() => setForm({ ...form, fitness: o.value })}
            />{" "}
            {FITNESS_LABEL[o.value]} <span className="muted small-text">· {o.hint}</span>
          </label>
        ))}
      </fieldset>
      {form.fitness === "FIT_WITH_CONDITION" ? (
        <>
          <label htmlFor={`${id}-fn`}>
            Tindak lanjut ringan (wajib, tanpa diagnosis)
            <input
              id={`${id}-fn`}
              maxLength={300}
              placeholder="Contoh: kontrol ulang ke klinik site"
              value={form.follow_up_note}
              onChange={(e) => setForm({ ...form, follow_up_note: e.target.value })}
            />
          </label>
          <label htmlFor={`${id}-fd`}>
            Tindak lanjut paling lambat (wajib)
            <input
              id={`${id}-fd`}
              type="date"
              value={form.follow_up_due}
              onChange={(e) => setForm({ ...form, follow_up_due: e.target.value })}
            />
          </label>
        </>
      ) : null}
      {form.fitness === "FIT_WITH_RESTRICTION" ? (
        <>
          <label htmlFor={`${id}-code`}>
            Pembatasan operasional (batasan kerja, bukan diagnosis)
            <select
              id={`${id}-code`}
              value={form.restriction_code}
              onChange={(e) => setForm({ ...form, restriction_code: e.target.value })}
            >
              <option value="">Pilih…</option>
              {RESTRICTION_CODES.map((x) => (
                <option key={x.code} value={x.code}>
                  {x.description}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={`${id}-ru`}>
            Pembatasan berlaku sampai
            <input
              id={`${id}-ru`}
              type="date"
              value={form.restriction_until}
              onChange={(e) => setForm({ ...form, restriction_until: e.target.value })}
            />
          </label>
        </>
      ) : null}
      {form.fitness === "UNFIT" ? (
        <label htmlFor={`${id}-uu`}>
          Tanggal tinjau ulang (opsional)
          <input
            id={`${id}-uu`}
            type="date"
            value={form.unfit_until}
            onChange={(e) => setForm({ ...form, unfit_until: e.target.value })}
          />
        </label>
      ) : null}
      <label htmlFor={`${id}-cm`}>
        Catatan penetapan (jangan memuat diagnosis)
        <input
          id={`${id}-cm`}
          maxLength={500}
          value={form.comment}
          onChange={(e) => setForm({ ...form, comment: e.target.value })}
        />
      </label>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <span className="row-actions">
        <button type="submit" disabled={busy}>
          Tetapkan
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Batal
        </button>
      </span>
    </form>
  );
}

function RejectForm({ record, onDone, onCancel }: { record: MedicalRecord; onDone: (t: string) => void; onCancel: () => void }) {
  const { getToken } = useSession();
  const id = useId();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="form"
      onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        if (!reason.trim()) return setError("Alasan wajib diisi.");
        const token = await getToken();
        if (!token) return;
        const r = await apiSend(
          "POST",
          `/medical-records/${record.id}/reject`,
          token,
          { reason: reason.trim() },
          { ifMatch: record.version },
        );
        if (!r.ok) return setError(medicalErrorMessage(r.error));
        onDone("Record MCU ditolak.");
      }}
    >
      <label htmlFor={`${id}-r`}>
        Alasan penolakan (wajib, tanpa diagnosis)
        <input id={`${id}-r`} required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <span className="row-actions">
        <button type="submit">Tolak</button>
        <button type="button" className="secondary" onClick={onCancel}>
          Batal
        </button>
      </span>
    </form>
  );
}

function AddMedicalRecord({
  workerId,
  onDone,
  onCancel,
}: {
  workerId: string;
  onDone: (t: string) => void;
  onCancel: () => void;
}) {
  const { getToken } = useSession();
  const id = useId();
  const [types, setTypes] = useState<MedicalExamType[]>([]);
  const [form, setForm] = useState({ type: "", exam: localToday(), expiry: "", provider: "" });
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void (async () => {
      const token = await getToken();
      if (!token) return;
      const r = await apiGet<MedicalExamType[]>("/medical-exam-types?status=ACTIVE", token);
      if (r.ok) setTypes(r.data);
    })();
  }, [getToken]);
  const pick = (tid: string) => {
    const t = types.find((x) => x.id === tid);
    setForm({
      ...form,
      type: tid,
      expiry: form.expiry || (t?.default_validity_months ? plusMonths(form.exam, t.default_validity_months) : ""),
    });
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.type) return setError("Pilih jenis pemeriksaan.");
    if (form.exam > localToday()) return setError("Tanggal pemeriksaan tidak boleh di masa depan.");
    if (!form.expiry || form.expiry < form.exam)
      return setError("Tanggal berlaku sampai wajib dan tidak lebih awal dari tanggal pemeriksaan.");
    setBusy(true);
    setError(null);
    const token = await getToken();
    if (!token) return;
    let fileId: string | null = null;
    if (file) {
      const up = await uploadFile(token, file, "MEDICAL_DOCUMENT");
      if (!up.ok) {
        setBusy(false);
        return setError(up.message);
      }
      fileId = up.file.id;
    }
    const r = await apiSend("POST", `/workers/${workerId}/medical-records`, token, {
      exam_type_id: form.type,
      examination_date: form.exam,
      expiry_date: form.expiry,
      provider: form.provider.trim() || null,
      file_id: fileId,
    });
    setBusy(false);
    if (!r.ok) return setError(medicalErrorMessage(r.error));
    onDone("MCU dicatat. Fit to Work ditetapkan oleh Dokter.");
  };
  return (
    <form className="form card entity-form" onSubmit={submit} aria-label="Catat MCU">
      <h3>Catat MCU</h3>
      <p className="muted small-text">Hanya data administratif. Jangan menulis diagnosis atau hasil laboratorium.</p>
      <label htmlFor={`${id}-t`}>
        Jenis pemeriksaan (wajib)
        <select id={`${id}-t`} required value={form.type} onChange={(e) => pick(e.target.value)}>
          <option value="">Pilih…</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={`${id}-e`}>
        Tanggal pemeriksaan (wajib)
        <input
          id={`${id}-e`}
          type="date"
          required
          max={localToday()}
          value={form.exam}
          onChange={(e) => setForm({ ...form, exam: e.target.value })}
        />
      </label>
      <label htmlFor={`${id}-x`}>
        Berlaku sampai (wajib)
        <input
          id={`${id}-x`}
          type="date"
          required
          value={form.expiry}
          onChange={(e) => setForm({ ...form, expiry: e.target.value })}
        />
      </label>
      <label htmlFor={`${id}-p`}>
        Penyedia (klinik)
        <input
          id={`${id}-p`}
          maxLength={150}
          value={form.provider}
          onChange={(e) => setForm({ ...form, provider: e.target.value })}
        />
      </label>
      <label htmlFor={`${id}-f`}>
        Dokumen MCU (PDF maks 10 MB, foto maks 20 MB) · disimpan di penyimpanan terbatas
        <input
          id={`${id}-f`}
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/webp"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <span className="row-actions">
        <button type="submit" disabled={busy}>
          {busy ? "Menyimpan…" : "Simpan"}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
          Batal
        </button>
      </span>
    </form>
  );
}

/** Otorisasi akses detail berbatas waktu (<= 24 jam) untuk HSE Manager, oleh Dokter (API-005 §7). */
function GrantForm({ recordId, onDone, onCancel }: { recordId: string; onDone: (t: string) => void; onCancel: () => void }) {
  const { getToken } = useSession();
  const id = useId();
  const [people, setPeople] = useState<{ id: string; full_name: string }[]>([]);
  const [form, setForm] = useState({ grantee: "", reason: "", hours: "4" });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      const token = await getToken();
      if (!token) return;
      const r = await apiGet<{ id: string; full_name: string }[]>("/medical-access-grantees", token);
      if (r.ok) setPeople(r.data);
    })();
  }, [getToken]);
  return (
    <form
      className="form"
      onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        if (!form.grantee) return setError("Pilih penerima.");
        if (form.reason.trim().length < MIN_ACCESS_REASON) return setError(`Alasan minimal ${MIN_ACCESS_REASON} karakter.`);
        const token = await getToken();
        if (!token) return;
        const r = await apiSend("POST", `/medical-records/${recordId}/access-grants`, token, {
          grantee_user_id: form.grantee,
          reason: form.reason.trim(),
          hours: Number(form.hours),
        });
        if (!r.ok) return setError(medicalErrorMessage(r.error));
        onDone(`Akses detail diberikan selama ${form.hours} jam.`);
      }}
    >
      <label htmlFor={`${id}-g`}>
        Penerima (HSE Manager)
        <select id={`${id}-g`} value={form.grantee} onChange={(e) => setForm({ ...form, grantee: e.target.value })}>
          <option value="">Pilih…</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.full_name}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={`${id}-rs`}>
        Alasan (wajib)
        <input
          id={`${id}-rs`}
          maxLength={500}
          value={form.reason}
          onChange={(e) => setForm({ ...form, reason: e.target.value })}
        />
      </label>
      <label htmlFor={`${id}-h`}>
        Lama akses
        <select id={`${id}-h`} value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })}>
          {["1", "4", "8", "24"].map((h) => (
            <option key={h} value={h}>
              {h} jam
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <span className="row-actions">
        <button type="submit">Beri akses</button>
        <button type="button" className="secondary" onClick={onCancel}>
          Batal
        </button>
      </span>
    </form>
  );
}

const CHECKS_EMPTY: Record<ClearanceChecklistKey, boolean> = {
  history_reviewed: false,
  blood_pressure_checked: false,
  vital_signs_checked: false,
  vitals_within_limits: false,
};

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * Kesiapan kerja khusus (B-27): daftar hasil 7 hari terakhir (tingkat status, tanpa checklist) dan, untuk Dokter,
 * formulir pemeriksaan pra-tugas. Angka tensi/tanda vital tidak dimasukkan ke aplikasi.
 */
export function ClearancePanel({
  workerId,
  canIssue,
  onChanged,
}: {
  workerId: string;
  canIssue: boolean;
  onChanged: (t: string) => void;
}) {
  const { getToken } = useSession();
  const [items, setItems] = useState<MedicalClearance[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const r = await apiGet<MedicalClearance[]>(`/workers/${workerId}/medical-clearances`, token);
    if (r.ok) setItems(r.data);
  }, [getToken, workerId]);
  useEffect(() => {
    void load();
  }, [load]);
  const revoke = async (e: FormEvent, clearanceId: string) => {
    e.preventDefault();
    if (!revokeReason.trim()) return setError("Alasan pencabutan wajib diisi.");
    const token = await getToken();
    if (!token) return;
    const r = await apiSend("POST", `/medical-clearances/${clearanceId}/revoke`, token, { reason: revokeReason.trim() });
    if (!r.ok) return setError(medicalErrorMessage(r.error));
    setRevoking(null);
    setRevokeReason("");
    onChanged("Kesiapan kerja khusus dicabut.");
    void load();
  };
  return (
    <div className="stack">
      <h3>Kesiapan kerja khusus</h3>
      {items && items.length === 0 ? <p className="muted small-text">Belum ada pemeriksaan kesiapan 7 hari terakhir.</p> : null}
      {items && items.length > 0 ? (
        <ul>
          {items.map((c) => (
            <li key={c.id}>
              <span className={c.active ? "badge badge-success" : "badge badge-neutral"}>
                {c.result === "CLEARED" ? (c.active ? "Siap" : "Siap (berakhir)") : "Tidak siap"}
              </span>{" "}
              {c.type_name} · diperiksa {fmtTime(c.examined_at)}
              {c.valid_until ? ` · berlaku s.d. ${fmtTime(c.valid_until)}` : ""}
              {canIssue && c.active && revoking !== c.id ? (
                <>
                  {" "}
                  <button type="button" className="secondary" onClick={() => setRevoking(c.id)}>
                    Cabut
                  </button>
                </>
              ) : null}
              {revoking === c.id ? (
                <form className="form" onSubmit={(e) => void revoke(e, c.id)} aria-label="Cabut kesiapan">
                  <label htmlFor={`cabut-${c.id}`}>
                    Alasan pencabutan (wajib, tanpa diagnosis)
                    <input
                      id={`cabut-${c.id}`}
                      maxLength={300}
                      value={revokeReason}
                      onChange={(e) => setRevokeReason(e.target.value)}
                    />
                  </label>
                  <span className="row-actions">
                    <button type="submit">Cabut kesiapan</button>
                    <button type="button" className="secondary" onClick={() => setRevoking(null)}>
                      Batal
                    </button>
                  </span>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {canIssue && !adding ? (
        <p>
          <button type="button" onClick={() => setAdding(true)}>
            Periksa kesiapan kerja khusus
          </button>
        </p>
      ) : null}
      {adding ? (
        <ClearanceForm
          workerId={workerId}
          onDone={(t) => {
            setAdding(false);
            onChanged(t);
            void load();
          }}
          onCancel={() => setAdding(false)}
        />
      ) : null}
    </div>
  );
}

export function ClearanceForm({
  workerId,
  onDone,
  onCancel,
}: {
  workerId: string;
  onDone: (t: string) => void;
  onCancel: () => void;
}) {
  const { getToken } = useSession();
  const id = useId();
  const [types, setTypes] = useState<MedicalClearanceType[]>([]);
  const [form, setForm] = useState({
    clearance_type_id: "",
    result: "" as "CLEARED" | "NOT_CLEARED" | "",
    checks: CHECKS_EMPTY,
    note: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void (async () => {
      const token = await getToken();
      if (!token) return;
      const r = await apiGet<MedicalClearanceType[]>("/medical-clearance-types", token);
      if (r.ok) setTypes(r.data.filter((t) => t.status === "ACTIVE"));
    })();
  }, [getToken]);
  const type = types.find((t) => t.id === form.clearance_type_id);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const bad = validateClearance(form);
    if (bad) return setError(bad);
    setBusy(true);
    const token = await getToken();
    if (!token) return;
    const r = await apiSend("POST", `/workers/${workerId}/medical-clearances`, token, {
      clearance_type_id: form.clearance_type_id,
      result: form.result,
      ...form.checks,
      ...(form.note.trim() ? { note: form.note.trim() } : {}),
    });
    setBusy(false);
    if (!r.ok) return setError(medicalErrorMessage(r.error));
    onDone(form.result === "CLEARED" ? "Pekerja dinyatakan siap untuk pekerjaan khusus." : "Hasil tidak siap dicatat.");
  };
  return (
    <form className="form" onSubmit={submit} aria-label="Pemeriksaan kesiapan kerja khusus">
      <label htmlFor={`${id}-type`}>
        Jenis pekerjaan khusus (wajib)
        <select
          id={`${id}-type`}
          value={form.clearance_type_id}
          onChange={(e) => setForm({ ...form, clearance_type_id: e.target.value })}
        >
          <option value="">Pilih…</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      {type ? <p className="muted small-text">Hasil siap berlaku {type.validity_hours} jam (satu shift).</p> : null}
      <fieldset>
        <legend>Checklist pemeriksaan (angka tensi dan tanda vital dicatat di rekam medis klinik, bukan di sini)</legend>
        {CLEARANCE_CHECKLIST.map((c) => (
          <label key={c.key} htmlFor={`${id}-${c.key}`} className="check">
            <input
              id={`${id}-${c.key}`}
              type="checkbox"
              checked={form.checks[c.key]}
              onChange={(e) => setForm({ ...form, checks: { ...form.checks, [c.key]: e.target.checked } })}
            />{" "}
            {c.label}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Hasil (wajib)</legend>
        <label htmlFor={`${id}-ok`} className="check">
          <input
            id={`${id}-ok`}
            type="radio"
            name={`${id}-result`}
            checked={form.result === "CLEARED"}
            onChange={() => setForm({ ...form, result: "CLEARED" })}
          />{" "}
          Siap bekerja
        </label>
        <label htmlFor={`${id}-no`} className="check">
          <input
            id={`${id}-no`}
            type="radio"
            name={`${id}-result`}
            checked={form.result === "NOT_CLEARED"}
            onChange={() => setForm({ ...form, result: "NOT_CLEARED" })}
          />{" "}
          Tidak siap
        </label>
      </fieldset>
      <label htmlFor={`${id}-note`}>
        Catatan batasan kerja / tindak lanjut{form.result === "NOT_CLEARED" ? " (wajib)" : ""} (tanpa diagnosis)
        <input id={`${id}-note`} maxLength={300} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
      </label>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <span className="row-actions">
        <button type="submit" disabled={busy}>
          Simpan hasil
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Batal
        </button>
      </span>
    </form>
  );
}

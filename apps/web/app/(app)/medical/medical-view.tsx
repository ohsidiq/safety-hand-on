"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { apiGet, apiSend } from "@/lib/api";
import {
  type ClearanceTypeFormValue,
  type ExamTypeFormValue,
  type MedicalClearanceType,
  type MedicalExamType,
  type MedicalRecord,
  medicalErrorMessage,
  RESTRICTION_CODES,
  validateClearanceType,
  validateExamType,
} from "@/lib/medical";
import { useMe, useSession } from "@/lib/session";
import { DeterminationForm } from "./medical-section";

/** Halaman Medical: antrean penetapan Dokter (medical.verify), jenis pemeriksaan dan jenis kerja khusus (readiness_profile.manage). */
export function MedicalView() {
  const { me } = useMe();
  const can = (p: string) => me.permissions.includes(p);
  if (!can("medical.verify") && !can("readiness_profile.manage"))
    return <p role="alert">Anda tidak berwenang membuka halaman ini.</p>;
  return (
    <>
      {can("medical.verify") ? <Queue /> : null}
      {can("readiness_profile.manage") ? <ExamTypes /> : null}
      {can("readiness_profile.manage") ? <ClearanceTypes /> : null}
    </>
  );
}

function Queue() {
  const { getToken } = useSession();
  const [items, setItems] = useState<MedicalRecord[]>([]);
  const [state, setState] = useState<"loading" | "idle" | "error">("loading");
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const r = await apiGet<MedicalRecord[]>("/medical-records/pending-determination?limit=100", token);
    if (r.ok) setItems(r.data);
    setState(r.ok ? "idle" : "error");
  }, [getToken]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="card panel" aria-labelledby="antrean-medis">
      <h2 id="antrean-medis">Menunggu penetapan Fit to Work</h2>
      {message ? <p role="status">{message}</p> : null}
      {state === "loading" ? <p role="status">Memuat…</p> : null}
      {state === "error" ? <p role="alert">Antrean tidak dapat dimuat.</p> : null}
      {state === "idle" && items.length === 0 ? <p className="muted">Tidak ada MCU yang menunggu penetapan.</p> : null}
      {items.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Pekerja</th>
                <th scope="col">Pemeriksaan</th>
                <th scope="col">Dicatat oleh</th>
                <th scope="col">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <QueueRow
                  key={it.id}
                  item={it}
                  expanded={open === it.id}
                  onToggle={() => setOpen(open === it.id ? null : it.id)}
                  onDone={(t) => {
                    setMessage(t);
                    setOpen(null);
                    void load();
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function QueueRow({
  item,
  expanded,
  onToggle,
  onDone,
}: {
  item: MedicalRecord;
  expanded: boolean;
  onToggle: () => void;
  onDone: (t: string) => void;
}) {
  return (
    <>
      <tr>
        <td>
          {item.worker_name ? <Link href={`/workers/${item.worker_id}`}>{item.worker_name}</Link> : "-"}
          <br />
          <span className="muted small-text">{item.sho_id}</span>
        </td>
        <td>
          {item.exam_type.name} · {item.examination_date}
          <br />
          <span className="muted small-text">berlaku s.d. {item.expiry_date}</span>
        </td>
        <td>{item.created_by_name ?? "-"}</td>
        <td>
          {item.can_determine ? (
            <button type="button" className="secondary" aria-expanded={expanded} onClick={onToggle}>
              {expanded ? "Tutup" : "Tetapkan"}
            </button>
          ) : (
            <span className="muted small-text">Dicatat oleh Anda: ditetapkan Dokter lain</span>
          )}
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={4}>
            <DeterminationForm record={item} onDone={onDone} onCancel={onToggle} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** Konfirmasi hapus di tempat (tanpa dialog peramban). */
function DeleteButton({ name, onConfirm }: { name: string; onConfirm: () => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!asking)
    return (
      <button type="button" className="secondary" onClick={() => setAsking(true)}>
        Hapus
      </button>
    );
  return (
    <span role="status">
      Hapus &quot;{name}&quot;?{" "}
      <button
        type="button"
        className="danger"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onConfirm();
          setBusy(false);
          setAsking(false);
        }}
      >
        Ya, hapus
      </button>{" "}
      <button type="button" className="secondary" onClick={() => setAsking(false)}>
        Batal
      </button>
    </span>
  );
}

/** Aksi baku master: nonaktifkan/aktifkan (POST + If-Match) dan hapus bila belum dipakai (DELETE, B-28). */
function useMasterActions(
  base: string,
  reload: () => void,
  setError: (e: string | null) => void,
  setMessage: (m: string) => void,
) {
  const { getToken } = useSession();
  const transition = async (t: { id: string; name: string; status: string; version: number }) => {
    const token = await getToken();
    if (!token) return;
    const action = t.status === "ACTIVE" ? "deactivate" : "reactivate";
    const r = await apiSend("POST", `${base}/${t.id}/${action}`, token, undefined, { ifMatch: t.version });
    if (!r.ok) {
      setError(medicalErrorMessage(r.error));
      if (r.error.code === "VERSION_CONFLICT") reload();
      return;
    }
    setError(null);
    setMessage(action === "deactivate" ? `"${t.name}" dinonaktifkan.` : `"${t.name}" diaktifkan kembali.`);
    reload();
  };
  const remove = async (t: { id: string; name: string; version: number }) => {
    const token = await getToken();
    if (!token) return;
    const r = await apiSend("DELETE", `${base}/${t.id}`, token, undefined, { ifMatch: t.version });
    if (!r.ok) {
      setError(medicalErrorMessage(r.error));
      if (r.error.code === "VERSION_CONFLICT") reload();
      return;
    }
    setError(null);
    setMessage(`"${t.name}" dihapus.`);
    reload();
  };
  return { transition, remove };
}

const EMPTY_EXAM_TYPE: ExamTypeFormValue = { name: "", code: "", months: "12" };

/** Jenis pemeriksaan MCU: tambah, ubah, nonaktifkan/aktifkan, hapus bila belum dipakai (B-28). */
function ExamTypes() {
  const { getToken } = useSession();
  const [items, setItems] = useState<MedicalExamType[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const r = await apiGet<MedicalExamType[]>("/medical-exam-types", token);
    if (r.ok) setItems(r.data);
  }, [getToken]);
  useEffect(() => {
    void load();
  }, [load]);
  const { transition, remove } = useMasterActions("/medical-exam-types", () => void load(), setError, setMessage);
  const body = (v: ExamTypeFormValue) => ({
    name: v.name.trim(),
    code: v.code.trim().toUpperCase(),
    default_validity_months: v.months.trim() ? Number(v.months) : null,
  });
  const save = async (v: ExamTypeFormValue, t?: MedicalExamType): Promise<boolean> => {
    const token = await getToken();
    if (!token) return false;
    const r = t
      ? await apiSend("PATCH", `/medical-exam-types/${t.id}`, token, body(v), { ifMatch: t.version })
      : await apiSend("POST", "/medical-exam-types", token, body(v));
    if (!r.ok) {
      setError(medicalErrorMessage(r.error));
      if (r.error.code === "VERSION_CONFLICT") void load();
      return false;
    }
    setError(null);
    setEditing(null);
    setMessage(t ? `Jenis pemeriksaan "${v.name.trim()}" diubah.` : "Jenis pemeriksaan ditambahkan.");
    void load();
    return true;
  };
  return (
    <section className="card panel" aria-labelledby="jenis-mcu">
      <h2 id="jenis-mcu">Jenis pemeriksaan</h2>
      {message ? <p role="status">{message}</p> : null}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <ul>
        {items.map((t) => (
          <li key={t.id}>
            {t.name} ({t.code}) · {t.default_validity_months ? `${t.default_validity_months} bulan` : "-"} ·{" "}
            {t.status === "ACTIVE" ? "Aktif" : "Nonaktif"}{" "}
            {editing !== t.id ? (
              <span className="row-actions">
                <button type="button" className="secondary" onClick={() => setEditing(t.id)}>
                  Ubah
                </button>
                <button type="button" className="secondary" onClick={() => void transition(t)}>
                  {t.status === "ACTIVE" ? "Nonaktifkan" : "Aktifkan"}
                </button>
                <DeleteButton name={t.name} onConfirm={() => remove(t)} />
              </span>
            ) : (
              <ExamTypeForm
                label={`Ubah jenis pemeriksaan ${t.name}`}
                submitText="Simpan perubahan"
                initial={{
                  name: t.name,
                  code: t.code,
                  months: t.default_validity_months ? String(t.default_validity_months) : "",
                }}
                onSubmit={(v) => save(v, t)}
                onCancel={() => setEditing(null)}
              />
            )}
          </li>
        ))}
      </ul>
      {editing === null ? (
        <ExamTypeForm
          label="Tambah jenis pemeriksaan"
          submitText="Tambah"
          initial={EMPTY_EXAM_TYPE}
          resetOnSuccess
          onSubmit={(v) => save(v)}
        />
      ) : null}
    </section>
  );
}

function ExamTypeForm({
  label,
  submitText,
  initial,
  resetOnSuccess = false,
  onSubmit,
  onCancel,
}: {
  label: string;
  submitText: string;
  initial: ExamTypeFormValue;
  resetOnSuccess?: boolean;
  onSubmit: (v: ExamTypeFormValue) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const id = useId();
  const [form, setForm] = useState<ExamTypeFormValue>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const bad = validateExamType(form);
    if (bad) return setError(bad);
    setError(null);
    setBusy(true);
    const done = await onSubmit(form);
    setBusy(false);
    if (done && resetOnSuccess) setForm(EMPTY_EXAM_TYPE);
  };
  return (
    <form className="form" onSubmit={submit} aria-label={label}>
      <label htmlFor={`${id}-n`}>
        Nama (wajib)
        <input
          id={`${id}-n`}
          required
          maxLength={150}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </label>
      <label htmlFor={`${id}-c`}>
        Kode (wajib)
        <input
          id={`${id}-c`}
          required
          maxLength={30}
          value={form.code}
          onChange={(e) => setForm({ ...form, code: e.target.value })}
        />
      </label>
      <label htmlFor={`${id}-m`}>
        Masa berlaku bawaan (bulan, boleh kosong)
        <input
          id={`${id}-m`}
          type="number"
          min={1}
          max={600}
          value={form.months}
          onChange={(e) => setForm({ ...form, months: e.target.value })}
        />
      </label>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <span className="row-actions">
        <button type="submit" disabled={busy}>
          {submitText}
        </button>
        {onCancel ? (
          <button type="button" className="secondary" onClick={onCancel}>
            Batal
          </button>
        ) : null}
      </span>
    </form>
  );
}

const EMPTY_CLEARANCE_TYPE: ClearanceTypeFormValue = { name: "", code: "", hours: "12", blocking: [] };

/**
 * Jenis kerja khusus yang mensyaratkan pemeriksaan kesiapan Dokter (B-27), mis. kerja di ketinggian.
 * Tambah, ubah (PATCH dengan If-Match), nonaktifkan dan aktifkan kembali. Tidak ada penghapusan.
 */
function ClearanceTypes() {
  const { getToken } = useSession();
  const [items, setItems] = useState<MedicalClearanceType[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const r = await apiGet<MedicalClearanceType[]>("/medical-clearance-types", token);
    if (r.ok) setItems(r.data);
  }, [getToken]);
  useEffect(() => {
    void load();
  }, [load]);
  const label = (code: string) => RESTRICTION_CODES.find((x) => x.code === code)?.description ?? code;
  const body = (v: ClearanceTypeFormValue) => ({
    name: v.name.trim(),
    code: v.code.trim().toUpperCase(),
    validity_hours: Number(v.hours),
    blocking_restriction_codes: v.blocking,
  });
  const create = async (v: ClearanceTypeFormValue): Promise<boolean> => {
    const token = await getToken();
    if (!token) return false;
    const r = await apiSend("POST", "/medical-clearance-types", token, body(v));
    if (!r.ok) {
      setError(medicalErrorMessage(r.error));
      return false;
    }
    setError(null);
    setMessage("Jenis kerja khusus ditambahkan.");
    void load();
    return true;
  };
  const update = async (t: MedicalClearanceType, v: ClearanceTypeFormValue): Promise<boolean> => {
    const token = await getToken();
    if (!token) return false;
    const r = await apiSend("PATCH", `/medical-clearance-types/${t.id}`, token, body(v), { ifMatch: t.version });
    if (!r.ok) {
      setError(medicalErrorMessage(r.error));
      if (r.error.code === "VERSION_CONFLICT") void load();
      return false;
    }
    setError(null);
    setEditing(null);
    setMessage(`Jenis kerja khusus "${v.name.trim()}" diubah.`);
    void load();
    return true;
  };
  const { transition, remove } = useMasterActions("/medical-clearance-types", () => void load(), setError, setMessage);
  return (
    <section className="card panel" aria-labelledby="jenis-kerja-khusus">
      <h2 id="jenis-kerja-khusus">Jenis kerja khusus (pemeriksaan kesiapan Dokter)</h2>
      {message ? <p role="status">{message}</p> : null}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <ul>
        {items.map((t) => (
          <li key={t.id}>
            {t.name} ({t.code}) · berlaku {t.validity_hours} jam
            {t.blocking_restriction_codes.length ? ` · terhalang: ${t.blocking_restriction_codes.map(label).join(", ")}` : ""} ·{" "}
            {t.status === "ACTIVE" ? "Aktif" : "Nonaktif"}{" "}
            {editing !== t.id ? (
              <span className="row-actions">
                <button type="button" className="secondary" onClick={() => setEditing(t.id)}>
                  Ubah
                </button>
                <button type="button" className="secondary" onClick={() => void transition(t)}>
                  {t.status === "ACTIVE" ? "Nonaktifkan" : "Aktifkan"}
                </button>
                <DeleteButton name={t.name} onConfirm={() => remove(t)} />
              </span>
            ) : (
              <ClearanceTypeForm
                label={`Ubah jenis kerja khusus ${t.name}`}
                submitText="Simpan perubahan"
                initial={{
                  name: t.name,
                  code: t.code,
                  hours: String(t.validity_hours),
                  blocking: t.blocking_restriction_codes,
                }}
                onSubmit={(v) => update(t, v)}
                onCancel={() => setEditing(null)}
              />
            )}
          </li>
        ))}
      </ul>
      {editing === null ? (
        <ClearanceTypeForm
          label="Tambah jenis kerja khusus"
          submitText="Tambah"
          initial={EMPTY_CLEARANCE_TYPE}
          resetOnSuccess
          onSubmit={create}
        />
      ) : null}
    </section>
  );
}

function ClearanceTypeForm({
  label,
  submitText,
  initial,
  resetOnSuccess = false,
  onSubmit,
  onCancel,
}: {
  label: string;
  submitText: string;
  initial: ClearanceTypeFormValue;
  resetOnSuccess?: boolean;
  onSubmit: (v: ClearanceTypeFormValue) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const id = useId();
  const [form, setForm] = useState<ClearanceTypeFormValue>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const bad = validateClearanceType(form);
    if (bad) return setError(bad);
    setError(null);
    setBusy(true);
    const done = await onSubmit(form);
    setBusy(false);
    if (done && resetOnSuccess) setForm(EMPTY_CLEARANCE_TYPE);
  };
  return (
    <form className="form" onSubmit={submit} aria-label={label}>
      <label htmlFor={`${id}-n`}>
        Nama (wajib)
        <input
          id={`${id}-n`}
          required
          maxLength={150}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </label>
      <label htmlFor={`${id}-c`}>
        Kode (wajib)
        <input
          id={`${id}-c`}
          required
          maxLength={30}
          value={form.code}
          onChange={(e) => setForm({ ...form, code: e.target.value })}
        />
      </label>
      <label htmlFor={`${id}-h`}>
        Masa berlaku hasil siap (jam, satu shift)
        <input
          id={`${id}-h`}
          type="number"
          min={1}
          max={24}
          value={form.hours}
          onChange={(e) => setForm({ ...form, hours: e.target.value })}
        />
      </label>
      <fieldset>
        <legend>Pembatasan medis yang menghalangi hasil siap</legend>
        {RESTRICTION_CODES.map((x) => (
          <label key={x.code} htmlFor={`${id}-b-${x.code}`} className="check">
            <input
              id={`${id}-b-${x.code}`}
              type="checkbox"
              checked={form.blocking.includes(x.code)}
              onChange={(e) =>
                setForm({
                  ...form,
                  blocking: e.target.checked ? [...form.blocking, x.code] : form.blocking.filter((b) => b !== x.code),
                })
              }
            />{" "}
            {x.description}
          </label>
        ))}
      </fieldset>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <span className="row-actions">
        <button type="submit" disabled={busy}>
          {submitText}
        </button>
        {onCancel ? (
          <button type="button" className="secondary" onClick={onCancel}>
            Batal
          </button>
        ) : null}
      </span>
    </form>
  );
}

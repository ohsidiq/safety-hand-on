"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { apiGet, apiSend } from "@/lib/api";
import {
  type MedicalClearanceType,
  type MedicalExamType,
  type MedicalRecord,
  medicalErrorMessage,
  RESTRICTION_CODES,
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

function ExamTypes() {
  const { getToken } = useSession();
  const id = useId();
  const [items, setItems] = useState<MedicalExamType[]>([]);
  const [form, setForm] = useState({ name: "", code: "", months: "12" });
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
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const code = form.code.trim().toUpperCase();
    if (form.name.trim().length < 2) return setError("Nama minimal 2 karakter.");
    if (!/^[A-Z0-9][A-Z0-9-]{1,29}$/.test(code)) return setError("Kode: huruf besar, angka, tanda hubung; 2-30 karakter.");
    const token = await getToken();
    if (!token) return;
    const r = await apiSend("POST", "/medical-exam-types", token, {
      name: form.name.trim(),
      code,
      default_validity_months: form.months ? Number(form.months) : null,
    });
    if (!r.ok) return setError(medicalErrorMessage(r.error));
    setError(null);
    setForm({ name: "", code: "", months: "12" });
    setMessage("Jenis pemeriksaan ditambahkan.");
    void load();
  };
  return (
    <section className="card panel" aria-labelledby="jenis-mcu">
      <h2 id="jenis-mcu">Jenis pemeriksaan</h2>
      {message ? <p role="status">{message}</p> : null}
      <ul>
        {items.map((t) => (
          <li key={t.id}>
            {t.name} ({t.code}) · {t.default_validity_months ? `${t.default_validity_months} bulan` : "-"} ·{" "}
            {t.status === "ACTIVE" ? "Aktif" : "Nonaktif"}
          </li>
        ))}
      </ul>
      <form className="form" onSubmit={submit} aria-label="Tambah jenis pemeriksaan">
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
          Masa berlaku bawaan (bulan)
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
        <button type="submit">Tambah</button>
      </form>
    </section>
  );
}

/** Jenis kerja khusus yang mensyaratkan pemeriksaan kesiapan Dokter (B-27), mis. kerja di ketinggian. */
function ClearanceTypes() {
  const { getToken } = useSession();
  const id = useId();
  const [items, setItems] = useState<MedicalClearanceType[]>([]);
  const [form, setForm] = useState({ name: "", code: "", hours: "12", blocking: [] as string[] });
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
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const code = form.code.trim().toUpperCase();
    const hours = Number(form.hours);
    if (form.name.trim().length < 2) return setError("Nama minimal 2 karakter.");
    if (!/^[A-Z0-9][A-Z0-9-]{1,29}$/.test(code)) return setError("Kode: huruf besar, angka, tanda hubung; 2-30 karakter.");
    if (!Number.isInteger(hours) || hours < 1 || hours > 24) return setError("Masa berlaku 1-24 jam.");
    const token = await getToken();
    if (!token) return;
    const r = await apiSend("POST", "/medical-clearance-types", token, {
      name: form.name.trim(),
      code,
      validity_hours: hours,
      blocking_restriction_codes: form.blocking,
    });
    if (!r.ok) return setError(medicalErrorMessage(r.error));
    setError(null);
    setForm({ name: "", code: "", hours: "12", blocking: [] });
    setMessage("Jenis kerja khusus ditambahkan.");
    void load();
  };
  return (
    <section className="card panel" aria-labelledby="jenis-kerja-khusus">
      <h2 id="jenis-kerja-khusus">Jenis kerja khusus (pemeriksaan kesiapan Dokter)</h2>
      {message ? <p role="status">{message}</p> : null}
      <ul>
        {items.map((t) => (
          <li key={t.id}>
            {t.name} ({t.code}) · berlaku {t.validity_hours} jam
            {t.blocking_restriction_codes.length ? ` · terhalang: ${t.blocking_restriction_codes.map(label).join(", ")}` : ""} ·{" "}
            {t.status === "ACTIVE" ? "Aktif" : "Nonaktif"}
          </li>
        ))}
      </ul>
      <form className="form" onSubmit={submit} aria-label="Tambah jenis kerja khusus">
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
        <button type="submit">Tambah</button>
      </form>
    </section>
  );
}

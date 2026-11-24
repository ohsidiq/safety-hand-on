"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { apiGet, apiSend } from "@/lib/api";
import {
  type CompetencyMaster,
  competencyErrorMessage,
  VALIDITY_BADGE,
  VALIDITY_LABEL,
  type WorkerCompetency,
} from "@/lib/competencies";
import { useMe, useSession } from "@/lib/session";
import { CompetencyDetail } from "./competency-section";

/** Halaman Kompetensi: antrean verifikasi (competency.verify) dan master (readiness_profile.manage). */
export function CompetenciesView() {
  const { me } = useMe();
  const can = (p: string) => me.permissions.includes(p);
  if (!can("competency.verify") && !can("readiness_profile.manage"))
    return <p role="alert">Anda tidak berwenang membuka halaman ini.</p>;
  return (
    <>
      {can("competency.verify") ? <VerificationQueue /> : null}
      {can("readiness_profile.manage") ? <MasterList /> : null}
    </>
  );
}

function VerificationQueue() {
  const { getToken } = useSession();
  const [items, setItems] = useState<WorkerCompetency[]>([]);
  const [state, setState] = useState<"loading" | "idle" | "error">("loading");
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const r = await apiGet<WorkerCompetency[]>("/competencies/pending-verification?limit=100", token);
    if (r.ok) setItems(r.data);
    setState(r.ok ? "idle" : "error");
  }, [getToken]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="card panel" aria-labelledby="antrean">
      <h2 id="antrean">Menunggu verifikasi</h2>
      {message ? <p role="status">{message}</p> : null}
      {state === "loading" ? <p role="status">Memuat…</p> : null}
      {state === "error" ? <p role="alert">Antrean tidak dapat dimuat.</p> : null}
      {state === "idle" && items.length === 0 ? <p className="muted">Tidak ada kompetensi yang menunggu verifikasi.</p> : null}
      {items.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Pekerja</th>
                <th scope="col">Kompetensi</th>
                <th scope="col">Diajukan</th>
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
                  onChanged={(t) => {
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
  onChanged,
}: {
  item: WorkerCompetency;
  expanded: boolean;
  onToggle: () => void;
  onChanged: (t: string) => void;
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
          {item.competency.name}
          <br />
          <span className={VALIDITY_BADGE[item.validity_status]}>{VALIDITY_LABEL[item.validity_status]}</span>
        </td>
        <td>
          {item.updated_at.slice(0, 10)}
          <br />
          <span className="muted small-text">oleh {item.created_by_name ?? "-"}</span>
        </td>
        <td>
          <button type="button" className="secondary" aria-expanded={expanded} onClick={onToggle}>
            {expanded ? "Tutup" : "Periksa"}
          </button>
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={4}>
            <p>
              Berlaku {item.valid_from} s.d. {item.valid_until ?? "tanpa batas"}
            </p>
            <CompetencyDetail item={item} canEdit={false} canVerify onChanged={onChanged} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function MasterList() {
  const { getToken } = useSession();
  const id = useId();
  const [items, setItems] = useState<CompetencyMaster[]>([]);
  const [form, setForm] = useState({ name: "", code: "", months: "" });
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const r = await apiGet<CompetencyMaster[]>("/competencies", token);
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
    const months = form.months ? Number(form.months) : null;
    if (months !== null && (!Number.isInteger(months) || months < 1 || months > 600))
      return setError("Masa berlaku bawaan 1-600 bulan.");
    setBusy(true);
    setError(null);
    const token = await getToken();
    if (!token) return;
    const r = await apiSend("POST", "/competencies", token, { name: form.name.trim(), code, default_validity_months: months });
    setBusy(false);
    if (!r.ok) return setError(competencyErrorMessage(r.error));
    setForm({ name: "", code: "", months: "" });
    setMessage("Kompetensi ditambahkan.");
    void load();
  };
  const toggle = async (m: CompetencyMaster) => {
    const token = await getToken();
    if (!token) return;
    const action = m.status === "ACTIVE" ? "deactivate" : "reactivate";
    const r = await apiSend("POST", `/competencies/${m.id}/${action}`, token, undefined, { ifMatch: m.version });
    if (!r.ok) return setError(competencyErrorMessage(r.error));
    setMessage(action === "deactivate" ? "Kompetensi dinonaktifkan." : "Kompetensi diaktifkan kembali.");
    void load();
  };

  return (
    <section className="card panel" aria-labelledby="master">
      <h2 id="master">Master kompetensi</h2>
      {message ? <p role="status">{message}</p> : null}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Kode</th>
              <th scope="col">Nama</th>
              <th scope="col">Masa berlaku bawaan</th>
              <th scope="col">Status</th>
              <th scope="col">Aksi</th>
            </tr>
          </thead>
          <tbody>
            {items.map((m) => (
              <tr key={m.id}>
                <td>{m.code}</td>
                <td>{m.name}</td>
                <td>{m.default_validity_months ? `${m.default_validity_months} bulan` : "-"}</td>
                <td>{m.status === "ACTIVE" ? "Aktif" : "Nonaktif"}</td>
                <td>
                  <button type="button" className="secondary" onClick={() => void toggle(m)}>
                    {m.status === "ACTIVE" ? "Nonaktifkan" : "Aktifkan"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="form" onSubmit={submit} aria-label="Tambah kompetensi">
        <h3>Tambah kompetensi</h3>
        <label htmlFor={`${id}-name`}>
          Nama (wajib)
          <input
            id={`${id}-name`}
            required
            maxLength={150}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label htmlFor={`${id}-code`}>
          Kode (wajib)
          <input
            id={`${id}-code`}
            required
            maxLength={30}
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
          />
        </label>
        <label htmlFor={`${id}-months`}>
          Masa berlaku bawaan (bulan)
          <input
            id={`${id}-months`}
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
        <button type="submit" disabled={busy}>
          {busy ? "Menyimpan…" : "Tambah"}
        </button>
      </form>
    </section>
  );
}

"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { apiGet, apiSend } from "@/lib/api";
import {
  AUTH_VALIDITY_BADGE,
  type AuthorizationType,
  authorizationErrorMessage,
  authStatusLabel,
  type WorkerAuthorization,
} from "@/lib/authorizations";
import { useMe, useSession } from "@/lib/session";
import { AuthorizationDetail } from "./authorization-section";

/** Halaman Otorisasi Kerja: antrean verifikasi (authorization.verify) dan jenis (readiness_profile.manage). */
export function AuthorizationsView() {
  const { me } = useMe();
  const can = (p: string) => me.permissions.includes(p);
  if (!can("authorization.verify") && !can("readiness_profile.manage"))
    return <p role="alert">Anda tidak berwenang membuka halaman ini.</p>;
  return (
    <>
      {can("authorization.verify") ? <Queue /> : null}
      {can("readiness_profile.manage") ? <Types /> : null}
    </>
  );
}

function Queue() {
  const { getToken } = useSession();
  const [items, setItems] = useState<WorkerAuthorization[]>([]);
  const [state, setState] = useState<"loading" | "idle" | "error">("loading");
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const r = await apiGet<WorkerAuthorization[]>("/authorizations/pending-verification?limit=100", token);
    if (r.ok) setItems(r.data);
    setState(r.ok ? "idle" : "error");
  }, [getToken]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="card panel" aria-labelledby="antrean-otorisasi">
      <h2 id="antrean-otorisasi">Menunggu verifikasi</h2>
      {message ? <p role="status">{message}</p> : null}
      {state === "loading" ? <p role="status">Memuat…</p> : null}
      {state === "error" ? <p role="alert">Antrean tidak dapat dimuat.</p> : null}
      {state === "idle" && items.length === 0 ? (
        <p className="muted">Tidak ada Otorisasi Kerja yang menunggu verifikasi.</p>
      ) : null}
      {items.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Pekerja</th>
                <th scope="col">Jenis</th>
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
  item: WorkerAuthorization;
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
          {item.authorization_type.name}
          <br />
          <span className={AUTH_VALIDITY_BADGE[item.validity_status]}>{authStatusLabel(item)}</span>
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
              {item.work_scope ? ` · Lingkup: ${item.work_scope}` : ""}
            </p>
            <AuthorizationDetail item={item} canEdit={false} canVerify onChanged={onChanged} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Types() {
  const { getToken } = useSession();
  const id = useId();
  const [items, setItems] = useState<AuthorizationType[]>([]);
  const [form, setForm] = useState({ name: "", code: "", months: "", scope: false });
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const r = await apiGet<AuthorizationType[]>("/authorization-types", token);
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
    const r = await apiSend("POST", "/authorization-types", token, {
      name: form.name.trim(),
      code,
      requires_work_scope: form.scope,
      default_validity_months: months,
    });
    setBusy(false);
    if (!r.ok) return setError(authorizationErrorMessage(r.error));
    setForm({ name: "", code: "", months: "", scope: false });
    setMessage("Jenis otorisasi ditambahkan.");
    void load();
  };
  const toggle = async (t: AuthorizationType) => {
    const token = await getToken();
    if (!token) return;
    const action = t.status === "ACTIVE" ? "deactivate" : "reactivate";
    const r = await apiSend("POST", `/authorization-types/${t.id}/${action}`, token, undefined, { ifMatch: t.version });
    if (!r.ok) return setError(authorizationErrorMessage(r.error));
    setMessage(action === "deactivate" ? "Jenis dinonaktifkan." : "Jenis diaktifkan kembali.");
    void load();
  };
  return (
    <section className="card panel" aria-labelledby="jenis-otorisasi">
      <h2 id="jenis-otorisasi">Jenis Otorisasi Kerja</h2>
      {message ? <p role="status">{message}</p> : null}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Kode</th>
              <th scope="col">Nama</th>
              <th scope="col">Lingkup wajib</th>
              <th scope="col">Masa berlaku bawaan</th>
              <th scope="col">Status</th>
              <th scope="col">Aksi</th>
            </tr>
          </thead>
          <tbody>
            {items.map((t) => (
              <tr key={t.id}>
                <td>{t.code}</td>
                <td>{t.name}</td>
                <td>{t.requires_work_scope ? "Ya" : "Tidak"}</td>
                <td>{t.default_validity_months ? `${t.default_validity_months} bulan` : "-"}</td>
                <td>{t.status === "ACTIVE" ? "Aktif" : "Nonaktif"}</td>
                <td>
                  <button type="button" className="secondary" onClick={() => void toggle(t)}>
                    {t.status === "ACTIVE" ? "Nonaktifkan" : "Aktifkan"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="form" onSubmit={submit} aria-label="Tambah jenis otorisasi">
        <h3>Tambah jenis</h3>
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
        <label htmlFor={`${id}-scope`} className="checkbox">
          <input
            id={`${id}-scope`}
            type="checkbox"
            checked={form.scope}
            onChange={(e) => setForm({ ...form, scope: e.target.checked })}
          />{" "}
          Wajib lingkup pekerjaan
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

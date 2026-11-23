"use client";

import Link from "next/link";
import { type ChangeEvent, useId, useState } from "react";
import { apiSend, apiUrl } from "@/lib/api";
import { useMe, useSession } from "@/lib/session";
import { type ImportResult, importErrorLabel } from "@/lib/workers";

/** Impor CSV pekerja (API-003 §6): periksa (dry_run) lalu impor dengan Idempotency-Key, galat per baris. */
export function ImportView() {
  const { me } = useMe();
  const { getToken } = useSession();
  const id = useId();
  const allowed = me.permissions.includes("worker.create");
  const [fileName, setFileName] = useState<string | null>(null);
  const [csv, setCsv] = useState<string>("");
  const [allOrNothing, setAllOrNothing] = useState(false);
  const [checked, setChecked] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!allowed) return <p role="alert">Anda tidak berwenang membuka halaman ini.</p>;

  async function downloadTemplate() {
    const token = await getToken();
    if (!token) return;
    const res = await fetch(apiUrl("/workers/imports/template"), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      setError("Templat tidak dapat diunduh.");
      return;
    }
    const href = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = href;
    a.download = "templat-impor-pekerja.csv";
    a.click();
    URL.revokeObjectURL(href);
  }

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    setChecked(null);
    setDone(null);
    setError(null);
    if (!f) return;
    if (f.size > 1_000_000) {
      setError("Berkas lebih dari 1 MB. Pecah menjadi beberapa berkas.");
      return;
    }
    setFileName(f.name);
    setCsv(await f.text());
    setKey(crypto.randomUUID()); // satu kunci per berkas: aman dicoba ulang bila koneksi putus
  }

  async function send(dryRun: boolean) {
    const token = await getToken();
    if (!token || !csv) return;
    setBusy(true);
    setError(null);
    const r = await fetchImport(token, csv, dryRun, allOrNothing, dryRun ? undefined : (key ?? undefined));
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      if (r.result) setDone(r.result);
      return;
    }
    if (dryRun) setChecked(r.result);
    else setDone(r.result);
  }

  const result = done ?? checked;
  return (
    <>
      <div className="toolbar">
        <span className="row-actions">
          <button type="button" className="secondary" onClick={downloadTemplate}>
            Unduh templat CSV
          </button>
          <Link href="/workers">Kembali ke daftar pekerja</Link>
        </span>
      </div>
      <div className="form card entity-form">
        <label htmlFor={`${id}-file`}>
          Berkas CSV
          <input id={`${id}-file`} type="file" accept=".csv,text/csv" onChange={pick} />
        </label>
        {fileName ? <p className="muted small-text">Dipilih: {fileName}</p> : null}
        <label className="check">
          <input type="checkbox" checked={allOrNothing} onChange={(e) => setAllOrNothing(e.target.checked)} />
          Batalkan semua bila ada satu baris gagal
        </label>
        <p className="muted small-text">
          Kolom wajib: employee_number, full_name, employment_status (PERMANENT, CONTRACT, CONTRACTOR), join_date (YYYY-MM-DD),
          site_code, department_code, job_position_code. Opsional: division_code, contractor_code, phone, email, national_id.
        </p>
        <span className="row-actions">
          <button type="button" className="secondary" disabled={!csv || busy} onClick={() => send(true)}>
            {busy ? "Memproses…" : "Periksa (tanpa menyimpan)"}
          </button>
          <button type="button" disabled={!checked || checked.created === 0 || busy || done !== null} onClick={() => send(false)}>
            Impor sekarang
          </button>
        </span>
      </div>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {result ? (
        <section className="card panel" aria-labelledby={`${id}-hasil`}>
          <h2 id={`${id}-hasil`}>
            {result.dry_run ? "Hasil pemeriksaan" : result.status === "REJECTED" ? "Impor dibatalkan" : "Impor selesai"}
          </h2>
          <p>
            {result.total_rows} baris · {result.dry_run ? "siap dibuat" : "dibuat"}: {result.created} · gagal: {result.failed}
            {result.replayed ? " · hasil permintaan sebelumnya" : ""}
          </p>
          {result.errors.length > 0 ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Baris</th>
                    <th>Kolom</th>
                    <th>Masalah</th>
                  </tr>
                </thead>
                <tbody>
                  {result.errors.map((e) => (
                    <tr key={`${e.row}-${e.field ?? ""}`}>
                      <td>{e.row}</td>
                      <td>{e.field ?? "-"}</td>
                      <td>{importErrorLabel(e.code)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {result.dry_run && result.created > 0 ? (
            <p className="muted small-text">
              {result.failed > 0 && !allOrNothing
                ? "Baris yang gagal akan dilewati. Perbaiki berkas lalu periksa ulang, atau lanjutkan impor."
                : "Klik Impor sekarang untuk menyimpan."}
            </p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

async function fetchImport(
  token: string,
  csv: string,
  dryRun: boolean,
  allOrNothing: boolean,
  key?: string,
): Promise<{ ok: true; result: ImportResult } | { ok: false; message: string; result?: ImportResult }> {
  const r = await apiSend<ImportResult>(
    "POST",
    "/workers/imports",
    token,
    { csv, dry_run: dryRun, all_or_nothing: allOrNothing },
    key ? { headers: { "Idempotency-Key": key } } : {},
  );
  if (r.ok) return { ok: true, result: r.data };
  const e = r.error;
  if (e.code === "IMPORT_VALIDATION_FAILED")
    return {
      ok: false,
      message: "Impor dibatalkan karena ada baris yang gagal. Tidak ada data yang disimpan.",
      result: e.extra.result as ImportResult,
    };
  const issue = e.details[0]?.issue ?? "";
  if (issue.startsWith("unknown_column:"))
    return { ok: false, message: `Kolom tidak dikenal: ${issue.slice(15)}. Gunakan templat.` };
  if (issue.startsWith("missing_column:")) return { ok: false, message: `Kolom wajib tidak ada: ${issue.slice(15)}.` };
  if (issue === "unreadable" || issue === "no_rows") return { ok: false, message: "Berkas CSV kosong atau tidak dapat dibaca." };
  if (e.code === "PAYLOAD_TOO_LARGE") return { ok: false, message: "Lebih dari 1.000 baris. Pecah menjadi beberapa berkas." };
  if (e.code === "IDEMPOTENCY_MISMATCH")
    return { ok: false, message: "Berkas berubah setelah diperiksa. Pilih ulang berkas lalu periksa lagi." };
  return { ok: false, message: "Impor tidak dapat diproses. Coba lagi." };
}

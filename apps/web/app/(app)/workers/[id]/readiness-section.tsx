"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiSend } from "@/lib/api";
import {
  ITEM_TYPE_LABEL,
  REASON_LABEL,
  type ReadinessSnapshot,
  readinessErrorMessage,
  requirementBadge,
  requirementText,
  STATUS_BADGE,
  STATUS_LABEL,
  TRIGGER_LABEL,
  type WorkerReadiness,
} from "@/lib/readiness";
import { useSession } from "@/lib/session";
import { formatTime } from "../../time";

/**
 * Status kesiapan pekerja (SRS-RE, UIUX-005). Status dihitung server dan diperbarui otomatis saat data berubah; skor hanya
 * informasi (B-02). Item medis yang tidak terpenuhi tampil "Syarat Medical belum terpenuhi" bagi peran non-medis.
 */
export function ReadinessSection({ workerId, canEvaluate }: { workerId: string; canEvaluate: boolean }) {
  const { getToken } = useSession();
  const [data, setData] = useState<WorkerReadiness | null>(null);
  const [state, setState] = useState<"loading" | "idle" | "none" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<ReadinessSnapshot[] | null>(null);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const r = await apiGet<WorkerReadiness>(`/workers/${workerId}/readiness`, token);
    if (r.ok) {
      setData(r.data);
      setState("idle");
    } else setState(r.status === 404 ? "none" : "error");
  }, [getToken, workerId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function evaluate() {
    const token = await getToken();
    if (!token) return;
    setBusy(true);
    setError(null);
    const r = await apiSend<WorkerReadiness>("POST", `/workers/${workerId}/readiness/evaluate`, token);
    setBusy(false);
    if (!r.ok) {
      setError(readinessErrorMessage(r.error));
      return;
    }
    setData(r.data);
    setState("idle");
    setHistory(null);
    setMessage(`Dinilai ulang: ${STATUS_LABEL[r.data.status]}.`);
  }

  async function toggleHistory() {
    if (history) {
      setHistory(null);
      return;
    }
    const token = await getToken();
    if (!token) return;
    const r = await apiGet<ReadinessSnapshot[]>(`/workers/${workerId}/readiness/history?limit=20`, token);
    setHistory(r.ok ? r.data : []);
  }

  return (
    <section className="card panel" aria-labelledby="kesiapan">
      <h2 id="kesiapan">Status kesiapan</h2>
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {state === "loading" ? <p role="status">Memuat…</p> : null}
      {state === "error" ? <p role="alert">Status kesiapan tidak dapat dimuat.</p> : null}
      {state === "none" ? <p className="muted">Belum dinilai. Penilaian berjalan otomatis dalam beberapa menit.</p> : null}
      {state === "idle" && data ? (
        <>
          <p>
            <span className={`badge ${STATUS_BADGE[data.status]}`}>{STATUS_LABEL[data.status]}</span>{" "}
            <span className="muted small-text">
              Skor {data.score} (informasi) · dinilai {formatTime(data.evaluated_at)}
              {data.profile ? ` · daftar syarat versi ${data.profile.version}` : ""}
            </span>
          </p>
          {data.reason_code ? <p>{REASON_LABEL[data.reason_code]}</p> : null}
          {data.items.length > 0 ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Syarat</th>
                    <th scope="col">Jenis</th>
                    <th scope="col">Status</th>
                    <th scope="col">Berlaku s.d.</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((i) => (
                    <tr key={i.profile_item_id}>
                      <td>
                        {i.requirement_name}
                        {i.is_mandatory ? "" : <span className="muted small-text"> (tidak wajib)</span>}
                      </td>
                      <td>{ITEM_TYPE_LABEL[i.item_type]}</td>
                      <td>
                        <span className={`badge ${requirementBadge(i.requirement_status)}`}>{requirementText(i)}</span>
                      </td>
                      <td className="nowrap">{i.expiry_date ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {data.next_evaluation_at ? (
            <p className="muted small-text">Penilaian terjadwal berikutnya: {formatTime(data.next_evaluation_at)}.</p>
          ) : null}
        </>
      ) : null}
      <span className="row-actions">
        {canEvaluate ? (
          <button type="button" className="secondary small" disabled={busy} onClick={() => void evaluate()}>
            {busy ? "Menilai…" : "Nilai ulang"}
          </button>
        ) : null}
        {state === "idle" ? (
          <button type="button" className="secondary small" aria-expanded={history !== null} onClick={() => void toggleHistory()}>
            {history ? "Sembunyikan riwayat" : "Riwayat perubahan"}
          </button>
        ) : null}
      </span>
      {history ? (
        history.length === 0 ? (
          <p className="muted">Belum ada riwayat.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Waktu</th>
                  <th scope="col">Status</th>
                  <th scope="col">Sebelumnya</th>
                  <th scope="col">Pemicu</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td className="nowrap">{formatTime(h.evaluated_at)}</td>
                    <td>
                      <span className={`badge ${STATUS_BADGE[h.status]}`}>{STATUS_LABEL[h.status]}</span>
                    </td>
                    <td>{h.previous_status ? STATUS_LABEL[h.previous_status] : "-"}</td>
                    <td>{TRIGGER_LABEL[h.trigger_type] ?? h.trigger_type}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </section>
  );
}

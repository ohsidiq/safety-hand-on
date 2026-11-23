"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { canSee } from "@/lib/nav";
import type { Site } from "@/lib/org";
import { useMe, useSession } from "@/lib/session";
import { EMPLOYMENT_LABEL, WORKER_STATUS_LABEL, type WorkerStatus, type WorkerSummary } from "@/lib/workers";

/** Daftar pekerja (UIUX-005 §4, API-003 §2). Status kesiapan menyusul bersama Readiness Engine (M4). */
export function WorkersView() {
  const { me } = useMe();
  const { getToken } = useSession();
  const allowed = canSee(me.permissions, "/workers");
  const canCreate = me.permissions.includes("worker.create");
  const [sites, setSites] = useState<Site[]>([]);
  const [filters, setFilters] = useState({ q: "", site_id: "", worker_status: "ACTIVE" });
  const [applied, setApplied] = useState(filters);
  const [rows, setRows] = useState<WorkerSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "idle" | "error">("loading");

  useEffect(() => {
    if (!allowed) return;
    void (async () => {
      const token = await getToken();
      if (!token) return;
      const r = await apiGet<Site[]>("/sites?status=ACTIVE", token);
      if (r.ok) setSites(r.data);
    })();
  }, [allowed, getToken]);

  const load = useCallback(
    async (next?: string) => {
      const token = await getToken();
      if (!token) return;
      setState("loading");
      const q = new URLSearchParams({ limit: "50" });
      if (applied.q.trim()) q.set("q", applied.q.trim());
      if (applied.site_id) q.set("site_id", applied.site_id);
      if (applied.worker_status) q.set("worker_status", applied.worker_status);
      if (next) q.set("cursor", next);
      const r = await apiGet<WorkerSummary[]>(`/workers?${q}`, token);
      if (!r.ok) {
        setState("error");
        return;
      }
      const p = (r.body as { pagination?: { next_cursor: string | null; has_more: boolean } }).pagination;
      setRows((prev) => (next ? [...prev, ...r.data] : r.data));
      setCursor(p?.has_more ? p.next_cursor : null);
      setState("idle");
    },
    [getToken, applied],
  );

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  // RT-007: tanpa permission tampilkan "tidak berwenang" tanpa memanggil API
  if (!allowed) return <p role="alert">Anda tidak berwenang membuka halaman ini.</p>;

  function apply(e: FormEvent) {
    e.preventDefault();
    setApplied(filters);
  }

  return (
    <>
      <form className="filters" onSubmit={apply} aria-label="Filter pekerja">
        <label>
          Cari
          <input
            type="search"
            value={filters.q}
            maxLength={100}
            placeholder="Nama, nomor pekerja, SHO ID"
            onChange={(e) => setFilters({ ...filters, q: e.target.value })}
          />
        </label>
        {sites.length > 0 ? (
          <label>
            Site
            <select value={filters.site_id} onChange={(e) => setFilters({ ...filters, site_id: e.target.value })}>
              <option value="">Semua</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          Status
          <select value={filters.worker_status} onChange={(e) => setFilters({ ...filters, worker_status: e.target.value })}>
            <option value="">Semua</option>
            {(Object.keys(WORKER_STATUS_LABEL) as WorkerStatus[]).map((s) => (
              <option key={s} value={s}>
                {WORKER_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Terapkan</button>
        {canCreate ? (
          <Link className="button-link" href="/workers/new">
            Tambah pekerja
          </Link>
        ) : null}
      </form>
      {state === "error" ? <p role="alert">Daftar pekerja tidak dapat dimuat. Coba lagi.</p> : null}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Nama</th>
              <th>Nomor pekerja</th>
              <th>SHO ID</th>
              <th>Posisi</th>
              <th>Site</th>
              <th>Status kerja</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => (
              <tr key={w.id}>
                <td>
                  <Link href={`/workers/${w.id}`}>{w.full_name}</Link>
                </td>
                <td className="nowrap">{w.employee_number}</td>
                <td className="nowrap">{w.sho_id}</td>
                <td>{w.job_position?.name ?? "-"}</td>
                <td>{w.site?.name ?? "-"}</td>
                <td>{EMPLOYMENT_LABEL[w.employment_status]}</td>
                <td>
                  <span className={w.worker_status === "ACTIVE" ? "badge badge-success" : "badge"}>
                    {WORKER_STATUS_LABEL[w.worker_status]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {state === "idle" && rows.length === 0 ? <p className="muted">Tidak ada pekerja yang cocok.</p> : null}
      {state === "loading" ? <p role="status">Memuat…</p> : null}
      {cursor && state === "idle" ? (
        <p>
          <button type="button" className="secondary" onClick={() => load(cursor)}>
            Muat lebih banyak
          </button>
        </p>
      ) : null}
    </>
  );
}

"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { type AuditEvent, fetchAuditPage } from "@/lib/api";
import { DAY, isoDate, MAX_DAYS, rangeFromDates } from "@/lib/audit-range";
import { ACTION_LABEL, canSee, ROLE_LABEL } from "@/lib/nav";
import { useMe, useSession } from "@/lib/session";
import { formatTime } from "../time";

const RESULT_LABEL: Record<AuditEvent["result"], string> = { SUCCESS: "Berhasil", DENIED: "Ditolak", FAILED: "Gagal" };

export function AuditView() {
  const { me } = useMe();
  const { getToken } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const today = isoDate(new Date());
  const weekAgo = isoDate(new Date(Date.now() - 6 * DAY));

  // Filter disimpan di query string agar dapat ditautkan (RT-005). Tidak ada data sensitif di sini.
  const fromDate = params.get("dari") ?? weekAgo;
  const toDate = params.get("sampai") ?? today;
  const action = params.get("aksi") ?? "";
  const result = params.get("hasil") ?? "";

  const [rows, setRows] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error" | "range">("idle");
  const allowed = canSee(me.permissions, "/audit");

  const load = useCallback(
    async (next?: string) => {
      const range = rangeFromDates(fromDate, toDate);
      if (!range) {
        setState("range");
        return;
      }
      const token = await getToken();
      if (!token) return;
      setState("loading");
      const r = await fetchAuditPage(token, { ...range, action: action || undefined, result: result || undefined, cursor: next });
      if (!r.ok) {
        setState("error");
        return;
      }
      setRows((prev) => (next ? [...prev, ...r.data] : r.data));
      setCursor(r.pagination?.has_more ? r.pagination.next_cursor : null);
      setState("idle");
    },
    [fromDate, toDate, action, result, getToken],
  );

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  // RT-007: tanpa permission tampilkan "tidak berwenang" tanpa memanggil API
  if (!allowed) return <p role="alert">Anda tidak berwenang membuka halaman ini.</p>;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const q = new URLSearchParams();
    for (const [k, v] of f.entries()) if (typeof v === "string" && v) q.set(k, v);
    router.replace(`${pathname}?${q.toString()}`);
  }

  return (
    <>
      <form className="filters" onSubmit={onSubmit} aria-label="Filter jejak audit">
        <label>
          Dari
          <input type="date" name="dari" defaultValue={fromDate} max={today} required />
        </label>
        <label>
          Sampai
          <input type="date" name="sampai" defaultValue={toDate} max={today} required />
        </label>
        <label>
          Aksi
          <select name="aksi" defaultValue={action}>
            <option value="">Semua</option>
            {Object.entries(ACTION_LABEL).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Hasil
          <select name="hasil" defaultValue={result}>
            <option value="">Semua</option>
            <option value="SUCCESS">Berhasil</option>
            <option value="DENIED">Ditolak</option>
            <option value="FAILED">Gagal</option>
          </select>
        </label>
        <button type="submit">Terapkan</button>
      </form>

      {state === "range" ? <p role="alert">Rentang tanggal tidak valid atau lebih dari {MAX_DAYS} hari.</p> : null}
      {state === "error" ? <p role="alert">Jejak audit tidak dapat dimuat. Coba lagi.</p> : null}

      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">Kejadian audit, terbaru lebih dulu</caption>
          <thead>
            <tr>
              <th scope="col">Waktu</th>
              <th scope="col">Pelaku</th>
              <th scope="col">Aksi</th>
              <th scope="col">Objek</th>
              <th scope="col">Hasil</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td className="nowrap">{formatTime(e.occurred_at)}</td>
                <td>
                  {e.actor?.full_name ?? (e.actor_kind === "SYSTEM" ? "Sistem" : "-")}
                  {e.actor?.role_code ? (
                    <span className="muted block">{ROLE_LABEL[e.actor.role_code] ?? e.actor.role_code}</span>
                  ) : null}
                </td>
                <td>
                  <details>
                    <summary>{ACTION_LABEL[e.action] ?? e.action}</summary>
                    <EventDetail e={e} />
                  </details>
                </td>
                <td>{e.entity_type}</td>
                <td>
                  <span className={`badge badge-${e.result.toLowerCase()}`}>{RESULT_LABEL[e.result]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {state === "idle" && rows.length === 0 ? <p className="muted">Tidak ada kejadian pada rentang ini.</p> : null}
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

function EventDetail({ e }: { e: AuditEvent }) {
  return (
    <dl className="facts small-text">
      <dt>Kode aksi</dt>
      <dd>
        <code>{e.action}</code>
      </dd>
      {e.changed_fields?.length ? (
        <>
          <dt>Field berubah</dt>
          <dd>{e.changed_fields.join(", ")}</dd>
        </>
      ) : null}
      {e.changes ? (
        <>
          <dt>Perubahan</dt>
          <dd>
            <pre className="pre">{JSON.stringify(e.changes, null, 2)}</pre>
          </dd>
        </>
      ) : null}
      {e.sensitive_access ? (
        <>
          <dt>Alasan akses</dt>
          <dd>{e.access_reason}</dd>
        </>
      ) : null}
      {e.ip !== undefined ? (
        <>
          <dt>IP</dt>
          <dd>{e.ip ?? "-"}</dd>
          <dt>Perangkat</dt>
          <dd className="break">{e.user_agent ?? "-"}</dd>
        </>
      ) : null}
      <dt>ID permintaan</dt>
      <dd className="break">{e.request_id ?? "-"}</dd>
    </dl>
  );
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api";
import { useMe, useSession } from "@/lib/session";
import {
  mergeQueue,
  QUEUE_PAGE_LIMIT,
  QUEUE_SOURCES,
  type QueueEntry,
  type QueueKind,
  type QueueSources,
  waitingLabel,
} from "@/lib/verifications";
import { AuthorizationDetail } from "../authorizations/authorization-section";
import { CompetencyDetail } from "../competencies/competency-section";
import { DeterminationForm } from "../medical/medical-section";
import { SimperDetail } from "../simpers/simper-section";

/** Antrean verifikasi gabungan (M3.6b, UIUX-005 §6.2). Verifikasi tetap memakai komponen dan aturan modul. */
export function VerificationsView() {
  const { me } = useMe();
  const { getToken } = useSession();
  const sources = useMemo(() => QUEUE_SOURCES.filter((s) => me.permissions.includes(s.permission)), [me.permissions]);
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [truncated, setTruncated] = useState<QueueKind[]>([]);
  const [failed, setFailed] = useState<QueueKind[]>([]);
  const [state, setState] = useState<"loading" | "idle">("loading");
  const [filter, setFilter] = useState<QueueKind | "ALL">("ALL");
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const results = await Promise.all(
      sources.map(async (s) => ({ s, r: await apiGet<unknown[]>(`${s.path}?limit=${QUEUE_PAGE_LIMIT}`, token) })),
    );
    const src: QueueSources = {};
    const bad: QueueKind[] = [];
    const full: QueueKind[] = [];
    for (const { s, r } of results) {
      if (!r.ok) {
        bad.push(s.kind);
        continue;
      }
      (src as Record<QueueKind, unknown[]>)[s.kind] = r.data;
      if (r.data.length >= QUEUE_PAGE_LIMIT) full.push(s.kind);
    }
    setEntries(mergeQueue(src));
    setFailed(bad);
    setTruncated(full);
    setState("idle");
  }, [getToken, sources]);

  useEffect(() => {
    void load();
  }, [load]);

  if (sources.length === 0) return <p role="alert">Anda tidak berwenang memverifikasi data apa pun.</p>;

  const counts = new Map<QueueKind, number>();
  for (const e of entries) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  const shown = filter === "ALL" ? entries : entries.filter((e) => e.kind === filter);
  const label = (k: QueueKind) => QUEUE_SOURCES.find((s) => s.kind === k)?.label ?? k;
  const page = (k: QueueKind) => QUEUE_SOURCES.find((s) => s.kind === k)?.page ?? "/";
  const done = (t: string) => {
    setMessage(t);
    setOpen(null);
    void load();
  };

  return (
    <section className="card panel" aria-labelledby="antrean-gabungan">
      <h2 id="antrean-gabungan">Menunggu tindakan ({entries.length})</h2>
      {message ? <p role="status">{message}</p> : null}
      <fieldset className="filters">
        <legend className="sr-only">Saring jenis</legend>
        <label>
          <input type="radio" name="jenis" checked={filter === "ALL"} onChange={() => setFilter("ALL")} /> Semua ({entries.length}
          )
        </label>
        {sources.map((s) => (
          <label key={s.kind}>
            <input type="radio" name="jenis" checked={filter === s.kind} onChange={() => setFilter(s.kind)} /> {s.label} (
            {counts.get(s.kind) ?? 0})
          </label>
        ))}
      </fieldset>
      {failed.length > 0 ? (
        <p role="alert">Antrean {failed.map(label).join(", ")} tidak dapat dimuat. Coba muat ulang halaman.</p>
      ) : null}
      {truncated.length > 0 ? (
        <p className="muted small-text">
          Menampilkan {QUEUE_PAGE_LIMIT} pengajuan terlama per jenis untuk{" "}
          {truncated.map((k, i) => (
            <span key={k}>
              {i > 0 ? ", " : ""}
              <Link href={page(k)}>{label(k)}</Link>
            </span>
          ))}
          ; sisanya ada di halaman modul.
        </p>
      ) : null}
      {state === "loading" ? <p role="status">Memuat…</p> : null}
      {state === "idle" && shown.length === 0 && failed.length === 0 ? (
        <p className="muted">Tidak ada pengajuan yang menunggu.</p>
      ) : null}
      {shown.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Menunggu</th>
                <th scope="col">Jenis</th>
                <th scope="col">Pekerja</th>
                <th scope="col">Data</th>
                <th scope="col">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => (
                <QueueRow
                  key={e.key}
                  entry={e}
                  kindLabel={label(e.kind)}
                  expanded={open === e.key}
                  onToggle={() => setOpen(open === e.key ? null : e.key)}
                  onDone={done}
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
  entry,
  kindLabel,
  expanded,
  onToggle,
  onDone,
}: {
  entry: QueueEntry;
  kindLabel: string;
  expanded: boolean;
  onToggle: () => void;
  onDone: (t: string) => void;
}) {
  const wait = waitingLabel(entry.waitingDays);
  return (
    <>
      <tr>
        <td>
          <span className={wait.overdue ? "badge badge-warning" : "badge badge-neutral"}>{wait.text}</span>
          <br />
          <span className="muted small-text">{entry.submittedAt.slice(0, 10)}</span>
        </td>
        <td>{kindLabel}</td>
        <td>
          {entry.workerName ? <Link href={`/workers/${entry.workerId}`}>{entry.workerName}</Link> : "-"}
          <br />
          <span className="muted small-text">{entry.shoId}</span>
        </td>
        <td>{entry.itemName}</td>
        <td>
          {entry.mine ? (
            <span className="muted small-text">Diajukan oleh Anda: diverifikasi orang lain</span>
          ) : (
            <button type="button" className="secondary" aria-expanded={expanded} onClick={onToggle}>
              {expanded ? "Tutup" : entry.kind === "MEDICAL" ? "Tetapkan" : "Periksa"}
            </button>
          )}
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={5}>
            <EntryDetail entry={entry} onDone={onDone} onCancel={onToggle} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function EntryDetail({ entry, onDone, onCancel }: { entry: QueueEntry; onDone: (t: string) => void; onCancel: () => void }) {
  const raw = entry.raw;
  switch (raw.kind) {
    case "COMPETENCY":
      return <CompetencyDetail item={raw.item} canEdit={false} canVerify onChanged={onDone} />;
    case "AUTHORIZATION":
      return <AuthorizationDetail item={raw.item} canEdit={false} canVerify onChanged={onDone} />;
    case "SIMPER":
      return <SimperDetail item={raw.item} canEdit={false} canVerify onChanged={(t) => onDone(t)} />;
    case "MEDICAL":
      return <DeterminationForm record={raw.item} onDone={onDone} onCancel={onCancel} />;
  }
}

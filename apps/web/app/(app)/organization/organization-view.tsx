"use client";

import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { apiGet, apiSend } from "@/lib/api";
import { canSee } from "@/lib/nav";
import {
  type Department,
  type EquipmentClass,
  ID_TIMEZONES,
  type JobPosition,
  normalizeCode,
  orgErrorMessage,
  type Site,
  STATUS_LABEL,
  type Team,
  type TeamMember,
  validateNameCode,
} from "@/lib/org";
import { useMe, useSession } from "@/lib/session";
import type { WorkerSummary } from "@/lib/workers";

/**
 * WF001 Organisasi dan Struktur (UIUX-005 §3, API-002). Semua data lewat Core API (ARCH-001).
 * Tombol hanya presentasi; server memeriksa permission dan scope setiap permintaan.
 */

type Row = { id: string; name: string; code: string; status: "ACTIVE" | "INACTIVE"; version: number } & Record<string, unknown>;

interface Field {
  key: string;
  label: string;
  kind: "text" | "code" | "timezone" | "textarea" | "select";
  required?: boolean;
  options?: { value: string; label: string }[];
  /** Hanya saat membuat (tidak dapat diubah lewat PATCH). */
  createOnly?: boolean;
  maxLength?: number;
}

interface Column {
  label: string;
  render: (row: Row) => ReactNode;
}

type Tab = "sites" | "positions" | "equipment";

export function OrganizationView() {
  const { me } = useMe();
  const [tab, setTab] = useState<Tab>("sites");
  const allowed = canSee(me.permissions, "/organization");
  const canManage = me.permissions.includes("organization.manage");

  // RT-007: tanpa permission tampilkan "tidak berwenang" tanpa memanggil API
  if (!allowed) return <p role="alert">Anda tidak berwenang membuka halaman ini.</p>;

  const tabs: { key: Tab; label: string }[] = [
    { key: "sites", label: "Site dan struktur" },
    { key: "positions", label: "Job Position" },
    { key: "equipment", label: "Kelas alat" },
  ];

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Bagian struktur organisasi">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={tab === t.key ? "tab active" : "tab"}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "sites" ? <SitesSection canManage={canManage} /> : null}
      {tab === "positions" ? (
        <EntityManager
          title="Job Position"
          path="/job-positions"
          itemBase="/job-positions"
          canManage={canManage}
          note="Job Position berlaku untuk seluruh organisasi. Syarat posisi diatur di Syarat per Posisi (Requirement Profile)."
          fields={[
            { key: "name", label: "Nama", kind: "text", required: true },
            { key: "code", label: "Kode", kind: "code", required: true },
            { key: "job_family", label: "Kelompok jabatan", kind: "text", maxLength: 100 },
            { key: "description", label: "Keterangan", kind: "textarea", maxLength: 1000 },
          ]}
          columns={[{ label: "Kelompok jabatan", render: (r) => (r as unknown as JobPosition).job_family ?? "-" }]}
        />
      ) : null}
      {tab === "equipment" ? (
        <EntityManager
          title="Kelas alat"
          path="/equipment-classes"
          itemBase="/equipment-classes"
          canManage={canManage}
          note="Dipakai untuk cakupan SIMPER."
          fields={[
            { key: "name", label: "Nama", kind: "text", required: true },
            { key: "code", label: "Kode", kind: "code", required: true },
            { key: "description", label: "Keterangan", kind: "textarea", maxLength: 1000 },
          ]}
          columns={[{ label: "Keterangan", render: (r) => (r as unknown as EquipmentClass).description ?? "-" }]}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- Site dan turunannya

function SitesSection({ canManage }: { canManage: boolean }) {
  const [selected, setSelected] = useState<Site | null>(null);
  return (
    <>
      <EntityManager
        title="Site"
        path="/sites"
        itemBase="/sites"
        canManage={canManage}
        fields={[
          { key: "name", label: "Nama", kind: "text", required: true },
          { key: "code", label: "Kode", kind: "code", required: true },
          { key: "location", label: "Lokasi", kind: "text", maxLength: 200 },
          { key: "timezone", label: "Zona waktu", kind: "timezone", required: true },
        ]}
        columns={[
          { label: "Zona waktu", render: (r) => (r as unknown as Site).timezone },
          { label: "Lokasi", render: (r) => (r as unknown as Site).location ?? "-" },
        ]}
        rowAction={(r) => (
          <button type="button" className="secondary small" onClick={() => setSelected(r as unknown as Site)}>
            Struktur
          </button>
        )}
        onChanged={(r) => setSelected((cur) => (cur && cur.id === r.id ? (r as unknown as Site) : cur))}
      />
      {selected ? <SitePanel key={selected.id} site={selected} canManage={canManage} onClose={() => setSelected(null)} /> : null}
    </>
  );
}

function SitePanel({ site, canManage, onClose }: { site: Site; canManage: boolean; onClose: () => void }) {
  const { getToken } = useSession();
  const [departments, setDepartments] = useState<Department[]>([]);
  const [division, setDivision] = useState<Department | null>(null);
  const [team, setTeam] = useState<Team | null>(null);

  const loadDepartments = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const r = await apiGet<Department[]>(`/sites/${site.id}/departments?status=ACTIVE`, token);
    if (r.ok) setDepartments(r.data);
  }, [getToken, site.id]);

  useEffect(() => {
    void loadDepartments();
  }, [loadDepartments]);

  const depName = (id: unknown) => departments.find((d) => d.id === id)?.name ?? "-";

  return (
    <section className="card panel" aria-labelledby={`site-${site.id}`}>
      <div className="toolbar">
        <h2 id={`site-${site.id}`}>
          {site.name} <span className="muted">({site.code})</span>
        </h2>
        <button type="button" className="secondary small" onClick={onClose}>
          Tutup
        </button>
      </div>
      <EntityManager
        title="Department"
        path={`/sites/${site.id}/departments`}
        itemBase="/departments"
        canManage={canManage}
        fields={[
          { key: "name", label: "Nama", kind: "text", required: true },
          { key: "code", label: "Kode", kind: "code", required: true },
        ]}
        columns={[]}
        rowAction={(r) => (
          <button type="button" className="secondary small" onClick={() => setDivision(r as unknown as Department)}>
            Divisi
          </button>
        )}
        onChanged={() => void loadDepartments()}
      />
      {division ? (
        <div className="subpanel">
          <div className="toolbar">
            <h3>Divisi di {division.name}</h3>
            <button type="button" className="secondary small" onClick={() => setDivision(null)}>
              Tutup
            </button>
          </div>
          <EntityManager
            key={division.id}
            title="Divisi"
            path={`/departments/${division.id}/divisions`}
            itemBase="/divisions"
            canManage={canManage}
            fields={[
              { key: "name", label: "Nama", kind: "text", required: true },
              { key: "code", label: "Kode", kind: "code", required: true },
            ]}
            columns={[]}
          />
        </div>
      ) : null}
      <EntityManager
        title="Tim"
        path={`/sites/${site.id}/teams`}
        itemBase="/teams"
        canManage={canManage}
        fields={[
          { key: "name", label: "Nama", kind: "text", required: true },
          { key: "code", label: "Kode", kind: "code", required: true },
          {
            key: "department_id",
            label: "Department",
            kind: "select",
            createOnly: true,
            options: departments.map((d) => ({ value: d.id, label: `${d.name} (${d.code})` })),
          },
        ]}
        columns={[{ label: "Department", render: (r) => depName(r.department_id) }]}
        rowAction={(r) => (
          <button type="button" className="secondary small" onClick={() => setTeam(r as unknown as Team)}>
            Anggota
          </button>
        )}
      />
      {team ? <MembersPanel key={team.id} team={team} canManage={canManage} onClose={() => setTeam(null)} /> : null}
    </section>
  );
}

function MembersPanel({ team, canManage, onClose }: { team: Team; canManage: boolean; onClose: () => void }) {
  const { getToken } = useSession();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [includeEnded, setIncludeEnded] = useState(false);
  const [state, setState] = useState<"loading" | "idle" | "error">("loading");
  const [ending, setEnding] = useState<string | null>(null);
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    setState("loading");
    const r = await apiGet<TeamMember[]>(`/teams/${team.id}/members${includeEnded ? "?include_ended=true" : ""}`, token);
    setState(r.ok ? "idle" : "error");
    if (r.ok) setMembers(r.data);
  }, [getToken, team.id, includeEnded]);

  useEffect(() => {
    void load();
  }, [load]);

  async function end(workerId: string) {
    const token = await getToken();
    if (!token) return;
    const r = await apiSend("POST", `/teams/${team.id}/members/${workerId}/end`, token, { valid_until: endDate });
    setMessage(r.ok ? "Keanggotaan diakhiri." : orgErrorMessage(r.error));
    setEnding(null);
    if (r.ok) void load();
  }

  return (
    <div className="subpanel">
      <div className="toolbar">
        <h3>Anggota {team.name}</h3>
        <button type="button" className="secondary small" onClick={onClose}>
          Tutup
        </button>
      </div>
      <p className="muted small-text">Keanggotaan memakai tanggal berlaku dan tidak dihapus.</p>
      {canManage && team.status === "ACTIVE" ? (
        <AddMember
          team={team}
          onAdded={(text) => {
            setMessage(text);
            void load();
          }}
        />
      ) : null}
      <label className="check">
        <input type="checkbox" checked={includeEnded} onChange={(e) => setIncludeEnded(e.target.checked)} />
        Tampilkan keanggotaan yang sudah berakhir
      </label>
      {message ? <p role="status">{message}</p> : null}
      {state === "error" ? <p role="alert">Anggota tidak dapat dimuat.</p> : null}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Nama</th>
              <th>SHO ID</th>
              <th>Mulai</th>
              <th>Berakhir</th>
              {canManage ? <th>Aksi</th> : null}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={`${m.worker_id}-${m.valid_from}`}>
                <td>{m.full_name ?? "(tidak dalam cakupan Anda)"}</td>
                <td className="nowrap">{m.sho_id ?? "-"}</td>
                <td className="nowrap">{m.valid_from}</td>
                <td className="nowrap">{m.valid_until ?? "-"}</td>
                {canManage ? (
                  <td>
                    {m.valid_until === null ? (
                      ending === m.worker_id ? (
                        <span className="inline-form">
                          <label>
                            <span className="sr-only">Tanggal berakhir</span>
                            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                          </label>
                          <button type="button" className="small" onClick={() => end(m.worker_id)}>
                            Akhiri
                          </button>
                          <button type="button" className="secondary small" onClick={() => setEnding(null)}>
                            Batal
                          </button>
                        </span>
                      ) : (
                        <button type="button" className="secondary small" onClick={() => setEnding(m.worker_id)}>
                          Akhiri keanggotaan
                        </button>
                      )
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {state === "idle" && members.length === 0 ? <p className="muted">Belum ada anggota.</p> : null}
    </div>
  );
}

/** Menambah anggota: cari pekerja aktif di Site tim (API-003 daftar pekerja), lalu tanggal mulai. */
function AddMember({ team, onAdded }: { team: Team; onAdded: (text: string) => void }) {
  const { getToken } = useSession();
  const id = useId();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<WorkerSummary[]>([]);
  const [workerId, setWorkerId] = useState("");
  const [from, setFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);

  async function search(e: FormEvent) {
    e.preventDefault();
    const token = await getToken();
    if (!token) return;
    const params = new URLSearchParams({ site_id: team.site_id, worker_status: "ACTIVE", limit: "20" });
    if (q.trim()) params.set("q", q.trim());
    const r = await apiGet<WorkerSummary[]>(`/workers?${params}`, token);
    setResults(r.ok ? r.data : []);
    setWorkerId("");
    setError(
      r.ok ? (r.data.length === 0 ? "Tidak ada pekerja aktif yang cocok di Site ini." : null) : "Pekerja tidak dapat dicari.",
    );
  }

  async function add() {
    const token = await getToken();
    if (!token || !workerId) return;
    const r = await apiSend("POST", `/teams/${team.id}/members`, token, { worker_id: workerId, valid_from: from });
    if (!r.ok) {
      setError(orgErrorMessage(r.error));
      return;
    }
    setResults([]);
    setWorkerId("");
    setQ("");
    setError(null);
    onAdded("Anggota ditambahkan.");
  }

  return (
    <form className="filters" onSubmit={search} aria-label="Tambah anggota tim">
      <label htmlFor={`${id}-q`}>
        Cari pekerja di Site tim
        <input
          id={`${id}-q`}
          type="search"
          value={q}
          maxLength={100}
          placeholder="Nama, nomor, SHO ID"
          onChange={(e) => setQ(e.target.value)}
        />
      </label>
      <button type="submit" className="secondary">
        Cari
      </button>
      {results.length > 0 ? (
        <>
          <label htmlFor={`${id}-w`}>
            Pekerja
            <select id={`${id}-w`} value={workerId} onChange={(e) => setWorkerId(e.target.value)}>
              <option value="">Pilih pekerja</option>
              {results.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.full_name} ({w.employee_number})
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={`${id}-from`}>
            Mulai
            <input id={`${id}-from`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <button type="button" onClick={add} disabled={!workerId}>
            Tambah anggota
          </button>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="error block">
          {error}
        </p>
      ) : null}
    </form>
  );
}

// ---------------------------------------------------------------- pengelola generik

function EntityManager(props: {
  title: string;
  path: string;
  itemBase: string;
  fields: Field[];
  columns: Column[];
  canManage: boolean;
  note?: string;
  rowAction?: (row: Row) => ReactNode;
  onChanged?: (row: Row) => void;
}) {
  const { title, path, itemBase, fields, columns, canManage, note, rowAction, onChanged } = props;
  const { getToken } = useSession();
  const [rows, setRows] = useState<Row[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [state, setState] = useState<"loading" | "idle" | "error">("loading");
  const [mode, setMode] = useState<{ kind: "create" } | { kind: "edit"; row: Row } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    setState("loading");
    const r = await apiGet<Row[]>(`${path}${showInactive ? "" : "?status=ACTIVE"}`, token);
    setState(r.ok ? "idle" : "error");
    if (r.ok) setRows(r.data);
  }, [getToken, path, showInactive]);

  useEffect(() => {
    void load();
  }, [load]);

  async function transition(row: Row, action: "deactivate" | "reactivate") {
    const token = await getToken();
    if (!token) return;
    const r = await apiSend<Row>("POST", `${itemBase}/${row.id}/${action}`, token, undefined, { ifMatch: row.version });
    setConfirm(null);
    if (!r.ok) {
      setMessage({ text: orgErrorMessage(r.error), error: true });
      return;
    }
    setMessage({
      text: `${title} ${r.data.name} ${action === "deactivate" ? "dinonaktifkan" : "diaktifkan kembali"}.`,
      error: false,
    });
    onChanged?.(r.data);
    void load();
  }

  function saved(row: Row, created: boolean) {
    setMode(null);
    setMessage({ text: `${title} ${row.name} ${created ? "dibuat" : "disimpan"}.`, error: false });
    onChanged?.(row);
    void load();
  }

  return (
    <section className="entity" aria-label={title}>
      <div className="toolbar">
        <h2 className="h3">{title}</h2>
        <span className="toolbar-group">
          <label className="check">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Tampilkan yang nonaktif
          </label>
          {canManage && mode?.kind !== "create" ? (
            <button type="button" className="small" onClick={() => setMode({ kind: "create" })}>
              Tambah {title}
            </button>
          ) : null}
        </span>
      </div>
      {note ? <p className="muted small-text">{note}</p> : null}
      {message ? (
        <p role={message.error ? "alert" : "status"} className={message.error ? "error" : undefined}>
          {message.text}
        </p>
      ) : null}
      {mode ? (
        <EntityForm
          title={title}
          fields={fields}
          mode={mode}
          path={path}
          itemBase={itemBase}
          onCancel={() => setMode(null)}
          onSaved={saved}
        />
      ) : null}
      {state === "error" ? <p role="alert">{title} tidak dapat dimuat. Coba lagi.</p> : null}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Nama</th>
              <th>Kode</th>
              {columns.map((c) => (
                <th key={c.label}>{c.label}</th>
              ))}
              <th>Status</th>
              <th>Aksi</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td className="nowrap">{r.code}</td>
                {columns.map((c) => (
                  <td key={c.label}>{c.render(r)}</td>
                ))}
                <td>
                  <span className={r.status === "ACTIVE" ? "badge badge-success" : "badge"}>{STATUS_LABEL[r.status]}</span>
                </td>
                <td>
                  <span className="row-actions">
                    {rowAction?.(r)}
                    {canManage ? (
                      <>
                        <button type="button" className="secondary small" onClick={() => setMode({ kind: "edit", row: r })}>
                          Ubah
                        </button>
                        {r.status === "ACTIVE" ? (
                          confirm === r.id ? (
                            <>
                              <button type="button" className="small danger" onClick={() => transition(r, "deactivate")}>
                                Ya, nonaktifkan
                              </button>
                              <button type="button" className="secondary small" onClick={() => setConfirm(null)}>
                                Batal
                              </button>
                            </>
                          ) : (
                            <button type="button" className="secondary small" onClick={() => setConfirm(r.id)}>
                              Nonaktifkan
                            </button>
                          )
                        ) : (
                          <button type="button" className="secondary small" onClick={() => transition(r, "reactivate")}>
                            Aktifkan kembali
                          </button>
                        )}
                      </>
                    ) : null}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {state === "idle" && rows.length === 0 ? <p className="muted">Belum ada {title.toLowerCase()}.</p> : null}
      {state === "loading" ? <p role="status">Memuat…</p> : null}
    </section>
  );
}

function EntityForm(props: {
  title: string;
  fields: Field[];
  mode: { kind: "create" } | { kind: "edit"; row: Row };
  path: string;
  itemBase: string;
  onCancel: () => void;
  onSaved: (row: Row, created: boolean) => void;
}) {
  const { title, fields, mode, path, itemBase, onCancel, onSaved } = props;
  const { getToken } = useSession();
  const formId = useId();
  const initial = mode.kind === "edit" ? mode.row : null;
  const visible = fields.filter((f) => !(f.createOnly && mode.kind === "edit"));
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      visible.map((f) => [f.key, initial ? String(initial[f.key] ?? "") : f.kind === "timezone" ? "Asia/Jakarta" : ""]),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tzChanged = initial !== null && "timezone" in values && values.timezone !== initial.timezone;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const invalid = validateNameCode(values.name ?? "", values.code ?? "");
    if (invalid) {
      setError(invalid);
      return;
    }
    const body: Record<string, unknown> = {};
    for (const f of visible) {
      const v = (values[f.key] ?? "").trim();
      if (initial) {
        if (v !== String(initial[f.key] ?? "")) body[f.key] = v === "" && !f.required ? null : v;
      } else if (v !== "") {
        body[f.key] = v;
      }
    }
    if (initial && Object.keys(body).length === 0) {
      onCancel();
      return;
    }
    const token = await getToken();
    if (!token) return;
    setBusy(true);
    const r = initial
      ? await apiSend<Row>("PATCH", `${itemBase}/${initial.id}`, token, body, { ifMatch: initial.version })
      : await apiSend<Row>("POST", path, token, body);
    setBusy(false);
    if (!r.ok) {
      setError(orgErrorMessage(r.error));
      return;
    }
    onSaved(r.data, !initial);
  }

  return (
    <form className="form card entity-form" onSubmit={submit} aria-labelledby={`${formId}-t`}>
      <h3 id={`${formId}-t`}>{initial ? `Ubah ${title}: ${initial.name}` : `Tambah ${title}`}</h3>
      {visible.map((f) => {
        const id = `${formId}-${f.key}`;
        const value = values[f.key] ?? "";
        const set = (v: string) => setValues((prev) => ({ ...prev, [f.key]: v }));
        return (
          <label key={f.key} htmlFor={id}>
            {f.label}
            {f.required ? " (wajib)" : ""}
            {f.kind === "textarea" ? (
              <textarea id={id} value={value} maxLength={f.maxLength} rows={3} onChange={(e) => set(e.target.value)} />
            ) : f.kind === "timezone" ? (
              <select id={id} value={value} onChange={(e) => set(e.target.value)} required>
                {ID_TIMEZONES.some((t) => t.value === value) ? null : <option value={value}>{value}</option>}
                {ID_TIMEZONES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            ) : f.kind === "select" ? (
              <select id={id} value={value} onChange={(e) => set(e.target.value)}>
                <option value="">(tidak ada)</option>
                {(f.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={id}
                value={value}
                required={f.required}
                maxLength={f.kind === "code" ? 30 : (f.maxLength ?? 150)}
                autoCapitalize={f.kind === "code" ? "characters" : undefined}
                onChange={(e) => set(f.kind === "code" ? normalizeCode(e.target.value) : e.target.value)}
              />
            )}
          </label>
        );
      })}
      {tzChanged ? (
        <p className="notice" role="status">
          Status kesiapan pekerja di site ini akan dievaluasi ulang.
        </p>
      ) : null}
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

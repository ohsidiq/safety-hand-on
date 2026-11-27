"use client";

import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { apiGet, apiSend } from "@/lib/api";
import type { JobPosition } from "@/lib/org";
import {
  type DraftItem,
  draftFromProfile,
  draftPayload,
  emptyDraftItem,
  ITEM_TYPE_LABEL,
  type ItemType,
  type RequirementProfile,
  readinessErrorMessage,
  validateDraft,
} from "@/lib/readiness";
import { useMe, useSession } from "@/lib/session";
import { formatTime } from "../time";

interface Master {
  id: string;
  name: string;
  code: string;
}
type Masters = Record<ItemType, Master[]> & { classes: Master[] };

const MASTER_PATH: Record<ItemType | "classes", string> = {
  COMPETENCY: "/competencies",
  MEDICAL: "/medical-exam-types",
  AUTHORIZATION: "/authorization-types",
  SIMPER: "/simper-types",
  classes: "/equipment-classes",
};
const ITEM_TYPES: ItemType[] = ["COMPETENCY", "MEDICAL", "AUTHORIZATION", "SIMPER"];

/** Syarat Jabatan (API-014 bagian 6): satu daftar aktif per jabatan, perubahan lewat draf versi baru (B-30). */
export function RequirementProfilesView() {
  const { me } = useMe();
  const { getToken } = useSession();
  const canManage = me.permissions.includes("readiness_profile.manage");
  const [positions, setPositions] = useState<JobPosition[]>([]);
  const [profiles, setProfiles] = useState<RequirementProfile[]>([]);
  const [masters, setMasters] = useState<Masters | null>(null);
  const [state, setState] = useState<"loading" | "idle" | "error">("loading");
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const [p, rp] = await Promise.all([
      apiGet<JobPosition[]>("/job-positions?status=ACTIVE", token),
      apiGet<RequirementProfile[]>("/requirement-profiles", token),
    ]);
    if (!p.ok || !rp.ok) {
      setState("error");
      return;
    }
    setPositions(p.data);
    setProfiles(rp.data);
    setState("idle");
  }, [getToken]);

  const loadMasters = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const keys = [...ITEM_TYPES, "classes"] as const;
    const res = await Promise.all(keys.map((k) => apiGet<Master[]>(`${MASTER_PATH[k]}?status=ACTIVE`, token)));
    const m = {} as Masters;
    keys.forEach((k, i) => {
      const r = res[i];
      m[k] = r?.ok ? r.data : [];
    });
    setMasters(m);
  }, [getToken]);

  useEffect(() => {
    if (canManage) {
      void load();
      void loadMasters();
    }
  }, [canManage, load, loadMasters]);

  if (!canManage) return <p role="alert">Anda tidak berwenang membuka halaman ini.</p>;
  if (state === "loading") return <p role="status">Memuat…</p>;
  if (state === "error") return <p role="alert">Data tidak dapat dimuat. Coba lagi.</p>;

  const byPosition = (id: string) => profiles.filter((p) => p.job_position.id === id);
  const position = positions.find((p) => p.id === selected) ?? null;

  return (
    <>
      <section className="card panel" aria-labelledby="daftar-jabatan">
        <h2 id="daftar-jabatan">Jabatan</h2>
        {positions.length === 0 ? <p className="muted">Belum ada jabatan aktif. Tambahkan di Struktur Organisasi.</p> : null}
        {positions.length > 0 ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Jabatan</th>
                  <th scope="col">Daftar syarat aktif</th>
                  <th scope="col">Draf</th>
                  <th scope="col">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const list = byPosition(p.id);
                  const active = list.find((x) => x.status === "ACTIVE");
                  const draft = list.find((x) => x.status === "DRAFT");
                  return (
                    <tr key={p.id}>
                      <td>
                        {p.name} <span className="muted small-text">({p.code})</span>
                      </td>
                      <td>
                        {active ? (
                          `Versi ${active.profile_version} · ${active.item_count} syarat`
                        ) : (
                          <span className="badge badge-warning">Belum ada</span>
                        )}
                      </td>
                      <td>{draft ? `Versi ${draft.profile_version}` : "-"}</td>
                      <td>
                        <button
                          type="button"
                          className="secondary small"
                          aria-expanded={selected === p.id}
                          onClick={() => setSelected(selected === p.id ? null : p.id)}
                        >
                          {selected === p.id ? "Tutup" : "Buka"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      {position && masters ? (
        <PositionPanel
          key={position.id}
          position={position}
          profiles={byPosition(position.id)}
          masters={masters}
          onChanged={load}
        />
      ) : null}
    </>
  );
}

function PositionPanel({
  position,
  profiles,
  masters,
  onChanged,
}: {
  position: JobPosition;
  profiles: RequirementProfile[];
  masters: Masters;
  onChanged: () => Promise<void>;
}) {
  const { getToken } = useSession();
  const [details, setDetails] = useState<Record<string, RequirementProfile>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const active = profiles.find((p) => p.status === "ACTIVE");
  const draft = profiles.find((p) => p.status === "DRAFT");
  const archived = profiles.filter((p) => p.status === "ARCHIVED");

  const loadDetail = useCallback(
    async (id: string) => {
      const token = await getToken();
      if (!token) return;
      const r = await apiGet<RequirementProfile>(`/requirement-profiles/${id}`, token);
      if (r.ok) setDetails((d) => ({ ...d, [id]: r.data }));
    },
    [getToken],
  );

  useEffect(() => {
    for (const p of [active, draft]) if (p) void loadDetail(p.id);
  }, [active, draft, loadDetail]);

  const after = async (text: string) => {
    setError(null);
    setMessage(text);
    setCreating(false);
    await onChanged();
  };

  async function newVersion(source: RequirementProfile) {
    const token = await getToken();
    if (!token) return;
    const r = await apiSend<RequirementProfile>("POST", `/requirement-profiles/${source.id}/new-version`, token);
    if (!r.ok) return setError(readinessErrorMessage(r.error));
    await after(`Draf versi ${r.data.profile_version} dibuat dari versi ${source.profile_version}.`);
  }

  const activeDetail = active ? details[active.id] : undefined;
  const draftDetail = draft ? details[draft.id] : undefined;

  return (
    <section className="card panel" aria-labelledby="syarat-jabatan">
      <h2 id="syarat-jabatan">Syarat untuk {position.name}</h2>
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}

      <h3>Aktif</h3>
      {active ? (
        <>
          <p className="muted small-text">
            Versi {active.profile_version}
            {active.activated_at ? ` · diaktifkan ${formatTime(active.activated_at)}` : ""}
            {active.notes ? ` · ${active.notes}` : ""}
          </p>
          {activeDetail ? <ItemTable profile={activeDetail} /> : <p role="status">Memuat…</p>}
          {!draft ? (
            <button type="button" className="secondary small" onClick={() => void newVersion(active)}>
              Buat versi baru
            </button>
          ) : null}
        </>
      ) : (
        <p className="muted">
          Belum ada daftar syarat aktif. Pekerja dengan jabatan ini berstatus Tidak siap sampai daftar syarat diaktifkan.
        </p>
      )}

      {draft ? (
        <>
          <h3>Draf versi {draft.profile_version}</h3>
          {draftDetail ? (
            <DraftEditor
              key={`${draftDetail.id}-${draftDetail.version}`}
              profile={draftDetail}
              positionId={position.id}
              masters={masters}
              onDone={after}
              onError={setError}
              onReload={() => loadDetail(draftDetail.id)}
            />
          ) : (
            <p role="status">Memuat…</p>
          )}
        </>
      ) : null}

      {!active && !draft ? (
        creating ? (
          <DraftEditor
            positionId={position.id}
            masters={masters}
            onDone={after}
            onError={setError}
            onCancel={() => setCreating(false)}
          />
        ) : (
          <button type="button" className="small" onClick={() => setCreating(true)}>
            Buat daftar syarat
          </button>
        )
      ) : null}

      {archived.length > 0 ? (
        <>
          <h3>Arsip</h3>
          <ul className="stack">
            {archived.map((p) => (
              <li key={p.id} className="muted small-text">
                Versi {p.profile_version} · {p.item_count} syarat
                {p.activated_at ? ` · aktif sejak ${formatTime(p.activated_at)}` : ""}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function ItemTable({ profile }: { profile: RequirementProfile }) {
  const items = profile.items ?? [];
  if (items.length === 0) return <p className="muted">Belum ada syarat.</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Jenis</th>
            <th scope="col">Syarat</th>
            <th scope="col">Wajib</th>
            <th scope="col">Peringatan</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id}>
              <td>{ITEM_TYPE_LABEL[i.item_type]}</td>
              <td>{i.requirement_name}</td>
              <td>{i.is_mandatory ? "Ya" : "Tidak"}</td>
              <td>{i.warning_days} hari sebelum berakhir</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Formulir draf: baru (POST) bila `profile` kosong, atau mengganti draf (PUT, If-Match). */
function DraftEditor({
  profile,
  positionId,
  masters,
  onDone,
  onError,
  onReload,
  onCancel,
}: {
  profile?: RequirementProfile;
  positionId: string;
  masters: Masters;
  onDone: (text: string) => Promise<void>;
  onError: (e: string | null) => void;
  onReload?: () => Promise<void>;
  onCancel?: () => void;
}) {
  const { getToken } = useSession();
  const id = useId();
  const [rows, setRows] = useState<DraftItem[]>(() => (profile ? draftFromProfile(profile.items) : [emptyDraftItem()]));
  const [notes, setNotes] = useState(profile?.notes ?? "");
  const [effective, setEffective] = useState(profile?.effective_from ?? "");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dirty, setDirty] = useState(false);

  const update = (n: number, patch: Partial<DraftItem>) => {
    setRows((r) => r.map((x, i) => (i === n ? { ...x, ...patch } : x)));
    setDirty(true);
  };

  const body = () => ({
    ...(notes.trim() ? { notes: notes.trim() } : {}),
    ...(effective ? { effective_from: effective } : {}),
    items: draftPayload(rows),
  });

  async function save(e?: FormEvent): Promise<RequirementProfile | null> {
    e?.preventDefault();
    const bad = validateDraft(rows);
    if (bad) {
      onError(bad);
      return null;
    }
    const token = await getToken();
    if (!token) return null;
    setBusy(true);
    const r = profile
      ? await apiSend<RequirementProfile>("PUT", `/requirement-profiles/${profile.id}`, token, body(), {
          ifMatch: profile.version,
        })
      : await apiSend<RequirementProfile>("POST", "/requirement-profiles", token, { job_position_id: positionId, ...body() });
    setBusy(false);
    if (!r.ok) {
      onError(readinessErrorMessage(r.error));
      if (r.error.code === "VERSION_CONFLICT") await onReload?.();
      return null;
    }
    setDirty(false);
    if (e) await onDone(profile ? "Draf disimpan." : "Draf dibuat. Aktifkan bila sudah lengkap.");
    return r.data;
  }

  async function activate() {
    if (!profile) return;
    const saved = dirty ? await save() : profile;
    if (!saved) return;
    const token = await getToken();
    if (!token) return;
    setBusy(true);
    const r = await apiSend<RequirementProfile>("POST", `/requirement-profiles/${saved.id}/activate`, token, undefined, {
      ifMatch: saved.version,
    });
    setBusy(false);
    if (!r.ok) {
      onError(readinessErrorMessage(r.error));
      if (r.error.code === "VERSION_CONFLICT") await onReload?.();
      return;
    }
    await onDone(
      `Versi ${r.data.profile_version} aktif. Status kesiapan pekerja jabatan ini diperbarui otomatis dalam sekitar satu menit.`,
    );
  }

  async function remove() {
    if (!profile) return;
    const token = await getToken();
    if (!token) return;
    setBusy(true);
    const r = await apiSend("DELETE", `/requirement-profiles/${profile.id}`, token);
    setBusy(false);
    if (!r.ok) return onError(readinessErrorMessage(r.error));
    await onDone("Draf dihapus.");
  }

  return (
    <form className="form" onSubmit={(e) => void save(e)} aria-label={profile ? "Ubah draf" : "Draf baru"}>
      {rows.length === 0 ? <p className="muted">Belum ada syarat. Tambahkan minimal satu sebelum mengaktifkan.</p> : null}
      {rows.map((row, n) => (
        <fieldset key={row.uid}>
          <legend>Syarat ke-{n + 1}</legend>
          <label htmlFor={`${id}-t-${n}`}>
            Jenis
            <select
              id={`${id}-t-${n}`}
              value={row.item_type}
              onChange={(e) => update(n, { item_type: e.target.value as ItemType, ref: "", classId: "" })}
            >
              {ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ITEM_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={`${id}-r-${n}`}>
            {ITEM_TYPE_LABEL[row.item_type]} yang disyaratkan
            <select id={`${id}-r-${n}`} required value={row.ref} onChange={(e) => update(n, { ref: e.target.value })}>
              <option value="">Pilih…</option>
              {masters[row.item_type].map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.code})
                </option>
              ))}
            </select>
          </label>
          {row.item_type === "SIMPER" ? (
            <label htmlFor={`${id}-k-${n}`}>
              Kelas alat (boleh kosong)
              <select id={`${id}-k-${n}`} value={row.classId} onChange={(e) => update(n, { classId: e.target.value })}>
                <option value="">Tanpa kelas alat tertentu</option>
                {masters.classes.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.code})
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label htmlFor={`${id}-w-${n}`}>
            Peringatan (hari sebelum berakhir)
            <input
              id={`${id}-w-${n}`}
              type="number"
              min={0}
              max={365}
              value={row.warning_days}
              onChange={(e) => update(n, { warning_days: e.target.value })}
            />
          </label>
          <label htmlFor={`${id}-m-${n}`} className="check">
            <input
              id={`${id}-m-${n}`}
              type="checkbox"
              checked={row.is_mandatory}
              onChange={(e) => update(n, { is_mandatory: e.target.checked })}
            />
            Wajib (bila tidak terpenuhi, pekerja Tidak siap)
          </label>
          <button
            type="button"
            className="secondary small"
            onClick={() => {
              setRows((r) => r.filter((_, i) => i !== n));
              setDirty(true);
            }}
          >
            Hapus syarat ini
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="secondary small"
        onClick={() => {
          setRows((r) => [...r, emptyDraftItem()]);
          setDirty(true);
        }}
      >
        Tambah syarat
      </button>
      <label htmlFor={`${id}-n`}>
        Catatan (boleh kosong)
        <textarea
          id={`${id}-n`}
          maxLength={1000}
          value={notes}
          onChange={(e) => {
            setNotes(e.target.value);
            setDirty(true);
          }}
        />
      </label>
      <label htmlFor={`${id}-e`}>
        Berlaku mulai (informasi, boleh kosong)
        <input
          id={`${id}-e`}
          type="date"
          value={effective}
          onChange={(e) => {
            setEffective(e.target.value);
            setDirty(true);
          }}
        />
      </label>
      <span className="row-actions">
        <button type="submit" disabled={busy}>
          {profile ? "Simpan draf" : "Buat draf"}
        </button>
        {profile ? (
          <button type="button" className="secondary" disabled={busy} onClick={() => void activate()}>
            Simpan dan aktifkan
          </button>
        ) : null}
        {onCancel ? (
          <button type="button" className="secondary" onClick={onCancel}>
            Batal
          </button>
        ) : null}
        {profile ? (
          confirmDelete ? (
            <span role="status">
              Hapus draf ini?{" "}
              <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
                Ya, hapus
              </button>{" "}
              <button type="button" className="secondary" onClick={() => setConfirmDelete(false)}>
                Batal
              </button>
            </span>
          ) : (
            <button type="button" className="secondary" onClick={() => setConfirmDelete(true)}>
              Hapus draf
            </button>
          )
        ) : null}
      </span>
    </form>
  );
}

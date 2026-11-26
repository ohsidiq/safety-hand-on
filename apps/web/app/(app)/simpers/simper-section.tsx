"use client";

import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { apiGet, apiSend } from "@/lib/api";
import { AUTH_VALIDITY_BADGE, authStatusLabel, suspensionActions } from "@/lib/authorizations";
import { suggestUntil } from "@/lib/competencies";
import { uploadFile } from "@/lib/files";
import type { EquipmentClass } from "@/lib/org";
import { useSession } from "@/lib/session";
import {
  activeClasses,
  CLASS_AUTH_LABEL,
  classAuthActions,
  classAuthWithinSimper,
  type Simper,
  type SimperClassAuth,
  type SimperType,
  simperErrorMessage,
} from "@/lib/simpers";

const localToday = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

const LABEL = { verify: "Verifikasi", reject: "Tolak", suspend: "Bekukan", reinstate: "Pulihkan", revoke: "Cabut" } as const;
type Action = keyof typeof LABEL;

/** Formulir alasan bersama (tolak, bekukan, pulihkan, cabut). */
function ReasonForm({
  action,
  busy,
  final,
  onSubmit,
  onCancel,
}: {
  action: Action;
  busy: boolean;
  final?: boolean;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  return (
    <form
      className="form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (reason.trim()) onSubmit(reason.trim());
      }}
    >
      {final ? <p className="muted small-text">Pencabutan bersifat akhir.</p> : null}
      <label htmlFor={`${id}-r`}>
        Alasan {LABEL[action].toLowerCase()} (wajib)
        <input id={`${id}-r`} required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <span className="row-actions">
        <button type="submit" disabled={busy || !reason.trim()}>
          {LABEL[action]}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Batal
        </button>
      </span>
    </form>
  );
}

/** SIMPER seorang pekerja beserta otorisasi kelas alat (UIUX WF006). */
export function SimperSection({
  workerId,
  canEdit,
  canVerify,
  title = "SIMPER",
}: {
  workerId: string;
  canEdit: boolean;
  canVerify: boolean;
  title?: string;
}) {
  const { getToken } = useSession();
  const [items, setItems] = useState<Simper[]>([]);
  const [state, setState] = useState<"loading" | "idle" | "error">("loading");
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const r = await apiGet<Simper[]>(`/workers/${workerId}/simpers`, token);
    if (r.ok) setItems(r.data);
    setState(r.ok ? "idle" : "error");
  }, [getToken, workerId]);
  useEffect(() => {
    void load();
  }, [load]);
  const changed = (text: string, keepOpen = false) => {
    setMessage(text);
    setAdding(false);
    if (!keepOpen) setOpen(null);
    void load();
  };
  return (
    <section className="card panel" aria-labelledby={`simper-${workerId}`}>
      <h2 id={`simper-${workerId}`}>{title}</h2>
      {message ? <p role="status">{message}</p> : null}
      {state === "loading" ? <p role="status">Memuat…</p> : null}
      {state === "error" ? <p role="alert">SIMPER tidak dapat dimuat.</p> : null}
      {state === "idle" && items.length === 0 ? <p className="muted">Belum ada SIMPER tercatat.</p> : null}
      {items.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Jenis</th>
                <th scope="col">Kelas alat aktif</th>
                <th scope="col">Berlaku</th>
                <th scope="col">Status</th>
                <th scope="col">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <SimperRow
                  key={it.id}
                  item={it}
                  expanded={open === it.id}
                  onToggle={() => setOpen(open === it.id ? null : it.id)}
                  canEdit={canEdit}
                  canVerify={canVerify}
                  onChanged={changed}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {canEdit && !adding ? (
        <p>
          <button type="button" onClick={() => setAdding(true)}>
            Ajukan SIMPER
          </button>
        </p>
      ) : null}
      {adding ? <AddSimper workerId={workerId} onDone={changed} onCancel={() => setAdding(false)} /> : null}
    </section>
  );
}

function SimperRow({
  item,
  expanded,
  onToggle,
  canEdit,
  canVerify,
  onChanged,
}: {
  item: Simper;
  expanded: boolean;
  onToggle: () => void;
  canEdit: boolean;
  canVerify: boolean;
  onChanged: (t: string, keepOpen?: boolean) => void;
}) {
  return (
    <>
      <tr>
        <td>
          {item.simper_type.name ?? "-"}
          <br />
          <span className="muted small-text">{item.simper_number ?? "Tanpa nomor"}</span>
        </td>
        <td>{activeClasses(item)}</td>
        <td>
          {item.valid_from} s.d. {item.valid_until ?? "tanpa batas"}
        </td>
        <td>
          <span className={AUTH_VALIDITY_BADGE[item.validity_status]}>{authStatusLabel(item)}</span>
        </td>
        <td>
          <button type="button" className="secondary" aria-expanded={expanded} onClick={onToggle}>
            {expanded ? "Tutup" : "Rincian"}
          </button>
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={5}>
            <SimperDetail item={item} canEdit={canEdit} canVerify={canVerify} onChanged={onChanged} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function SimperDetail({
  item,
  canEdit,
  canVerify,
  onChanged,
}: {
  item: Simper;
  canEdit: boolean;
  canVerify: boolean;
  onChanged: (t: string, keepOpen?: boolean) => void;
}) {
  const { getToken } = useSession();
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Action | "edit" | "class" | null>(null);
  const [until, setUntil] = useState(item.valid_until ?? "");
  const revoked = item.suspension_status === "REVOKED";

  const send = async (path: string, body: unknown, done: string, version: number, method: "POST" | "PATCH" = "POST") => {
    setBusy(true);
    setError(null);
    const token = await getToken();
    if (!token) return;
    const r = await apiSend(method, path, token, body, { ifMatch: version });
    setBusy(false);
    if (!r.ok) return setError(simperErrorMessage(r.error));
    setPending(null);
    onChanged(done, true);
  };
  const openDoc = async () => {
    const token = await getToken();
    if (!token) return;
    const r = await apiGet<{ url: string }>(`/simpers/${item.id}/document-url`, token);
    if (!r.ok) return setError("Dokumen tidak dapat dibuka.");
    window.open(r.data.url, "_blank", "noopener,noreferrer");
  };
  const actions: Action[] = [];
  if (canVerify && item.can_verify) actions.push("verify", "reject");
  if (canVerify && !revoked) actions.push(...suspensionActions(item.suspension_status));

  return (
    <div className="stack">
      <dl className="facts">
        <dt>Penerbit</dt>
        <dd>{item.issuer ?? "-"}</dd>
        <dt>Dicatat oleh</dt>
        <dd>{item.created_by_name ?? "-"}</dd>
        {item.verified_by_name ? (
          <>
            <dt>{item.verification_status === "REJECTED" ? "Ditolak oleh" : "Diverifikasi oleh"}</dt>
            <dd>
              {item.verified_by_name}
              {item.rejection_reason ? ` · ${item.rejection_reason}` : ""}
            </dd>
          </>
        ) : null}
        {item.suspension_status !== "NONE" ? (
          <>
            <dt>{revoked ? "Dicabut oleh" : "Dibekukan oleh"}</dt>
            <dd>
              {item.suspended_by_name ?? "-"} · {item.suspension_reason}
            </dd>
          </>
        ) : null}
      </dl>
      {item.suspension_status !== "NONE" ? (
        <p className="muted small-text">
          SIMPER {revoked ? "dicabut" : "dibekukan"}: seluruh otorisasi kelas alat di bawahnya tidak berlaku.
        </p>
      ) : null}
      <h3>Otorisasi kelas alat</h3>
      <ul>
        {item.equipment_authorizations.map((a) => (
          <ClassAuthItem
            key={a.id}
            auth={a}
            canVerify={canVerify && !revoked}
            onChanged={(t) => onChanged(t, true)}
            onError={setError}
          />
        ))}
      </ul>
      {item.has_document ? (
        <p>
          <button type="button" className="secondary" onClick={() => void openDoc()}>
            Buka dokumen
          </button>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {canVerify && item.verification_status === "PENDING" && !item.can_verify && !revoked ? (
        <p className="muted small-text">Data yang Anda catat diverifikasi orang lain.</p>
      ) : null}
      {pending === null ? (
        <span className="row-actions">
          {actions.map((a) => (
            <button
              key={a}
              type="button"
              className={a === "verify" ? undefined : "secondary"}
              disabled={busy}
              onClick={() =>
                a === "verify" ? void send(`/simpers/${item.id}/verify`, {}, "SIMPER diverifikasi.", item.version) : setPending(a)
              }
            >
              {LABEL[a]}
            </button>
          ))}
          {canEdit && !revoked ? (
            <>
              <button type="button" className="secondary" onClick={() => setPending("edit")}>
                Ubah masa berlaku
              </button>
              <button type="button" className="secondary" onClick={() => setPending("class")}>
                Tambah kelas alat
              </button>
            </>
          ) : null}
        </span>
      ) : null}
      {pending && pending !== "edit" && pending !== "class" && pending !== "verify" ? (
        <ReasonForm
          action={pending}
          busy={busy}
          final={pending === "revoke"}
          onCancel={() => setPending(null)}
          onSubmit={(reason) =>
            void send(
              `/simpers/${item.id}/${pending}`,
              { reason },
              `SIMPER: ${LABEL[pending].toLowerCase()} berhasil.`,
              item.version,
            )
          }
        />
      ) : null}
      {pending === "edit" ? (
        <form
          className="form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (until && until < item.valid_from) return setError("Berlaku sampai tidak boleh lebih awal dari tanggal mulai.");
            void send(
              `/simpers/${item.id}`,
              { valid_until: until || null },
              "Masa berlaku diubah dan menunggu verifikasi.",
              item.version,
              "PATCH",
            );
          }}
        >
          {item.verification_status !== "PENDING" ? (
            <p className="muted small-text">Perubahan mengembalikan status ke Menunggu verifikasi.</p>
          ) : null}
          <label htmlFor={`${id}-until`}>
            Berlaku sampai (kosong = tanpa batas)
            <input id={`${id}-until`} type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          </label>
          <span className="row-actions">
            <button type="submit" disabled={busy}>
              Simpan
            </button>
            <button type="button" className="secondary" onClick={() => setPending(null)}>
              Batal
            </button>
          </span>
        </form>
      ) : null}
      {pending === "class" ? (
        <AddClassAuth
          simper={item}
          onDone={() => {
            setPending(null);
            onChanged("Kelas alat ditambahkan; SIMPER menunggu verifikasi.", true);
          }}
          onCancel={() => setPending(null)}
        />
      ) : null}
    </div>
  );
}

function ClassAuthItem({
  auth,
  canVerify,
  onChanged,
  onError,
}: {
  auth: SimperClassAuth;
  canVerify: boolean;
  onChanged: (t: string) => void;
  onError: (t: string | null) => void;
}) {
  const { getToken } = useSession();
  const [pending, setPending] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: Action, reason: string) => {
    setBusy(true);
    onError(null);
    const token = await getToken();
    if (!token) return;
    const r = await apiSend("POST", `/simper-authorizations/${auth.id}/${action}`, token, { reason }, { ifMatch: auth.version });
    setBusy(false);
    if (!r.ok) return onError(simperErrorMessage(r.error));
    setPending(null);
    onChanged(`Kelas alat ${auth.equipment_class.name}: ${LABEL[action].toLowerCase()} berhasil.`);
  };
  return (
    <li>
      <strong>{auth.equipment_class.name}</strong> · {auth.valid_from} s.d. {auth.valid_until ?? "tanpa batas"} ·{" "}
      {CLASS_AUTH_LABEL[auth.status]}
      {auth.restriction_note ? ` · ${auth.restriction_note}` : ""}
      {auth.status_reason && auth.status !== "ACTIVE" ? ` · ${auth.status_reason}` : ""}{" "}
      {canVerify && !pending
        ? classAuthActions(auth.status).map((a) => (
            <button key={a} type="button" className="secondary" onClick={() => setPending(a)}>
              {LABEL[a]}
            </button>
          ))
        : null}
      {pending ? (
        <ReasonForm
          action={pending}
          busy={busy}
          final={pending === "revoke"}
          onCancel={() => setPending(null)}
          onSubmit={(reason) => void run(pending, reason)}
        />
      ) : null}
    </li>
  );
}

function useEquipmentClasses() {
  const { getToken } = useSession();
  const [classes, setClasses] = useState<EquipmentClass[]>([]);
  useEffect(() => {
    void (async () => {
      const token = await getToken();
      if (!token) return;
      const r = await apiGet<EquipmentClass[]>("/equipment-classes?status=ACTIVE", token);
      if (r.ok) setClasses(r.data);
    })();
  }, [getToken]);
  return classes;
}

function AddClassAuth({ simper, onDone, onCancel }: { simper: Simper; onDone: () => void; onCancel: () => void }) {
  const { getToken } = useSession();
  const id = useId();
  const classes = useEquipmentClasses();
  const [form, setForm] = useState({ cls: "", from: simper.valid_from, until: simper.valid_until ?? "", restriction: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const taken = new Set(simper.equipment_authorizations.filter((a) => a.status !== "REVOKED").map((a) => a.equipment_class.id));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.cls) return setError("Pilih kelas alat.");
    const bad = classAuthWithinSimper(
      { valid_from: form.from, valid_until: form.until },
      { valid_from: simper.valid_from, valid_until: simper.valid_until ?? "" },
    );
    if (bad) return setError(bad);
    setBusy(true);
    const token = await getToken();
    if (!token) return;
    const r = await apiSend("POST", `/simpers/${simper.id}/authorizations`, token, {
      equipment_class_id: form.cls,
      valid_from: form.from,
      valid_until: form.until || null,
      restriction_note: form.restriction.trim() || null,
    });
    setBusy(false);
    if (!r.ok) return setError(simperErrorMessage(r.error));
    onDone();
  };
  return (
    <form className="form" onSubmit={submit} aria-label="Tambah kelas alat">
      {simper.verification_status !== "PENDING" ? (
        <p className="muted small-text">Kelas alat baru mengembalikan SIMPER ke Menunggu verifikasi.</p>
      ) : null}
      <label htmlFor={`${id}-cls`}>
        Kelas alat (wajib)
        <select id={`${id}-cls`} required value={form.cls} onChange={(e) => setForm({ ...form, cls: e.target.value })}>
          <option value="">Pilih…</option>
          {classes
            .filter((c) => !taken.has(c.id))
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </label>
      <label htmlFor={`${id}-from`}>
        Berlaku mulai
        <input
          id={`${id}-from`}
          type="date"
          required
          value={form.from}
          onChange={(e) => setForm({ ...form, from: e.target.value })}
        />
      </label>
      <label htmlFor={`${id}-until`}>
        Berlaku sampai
        <input id={`${id}-until`} type="date" value={form.until} onChange={(e) => setForm({ ...form, until: e.target.value })} />
      </label>
      <label htmlFor={`${id}-restr`}>
        Pembatasan
        <input
          id={`${id}-restr`}
          maxLength={500}
          value={form.restriction}
          onChange={(e) => setForm({ ...form, restriction: e.target.value })}
        />
      </label>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <span className="row-actions">
        <button type="submit" disabled={busy}>
          Tambah
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Batal
        </button>
      </span>
    </form>
  );
}

function AddSimper({ workerId, onDone, onCancel }: { workerId: string; onDone: (t: string) => void; onCancel: () => void }) {
  const { getToken } = useSession();
  const id = useId();
  const classes = useEquipmentClasses();
  const [types, setTypes] = useState<SimperType[]>([]);
  const [form, setForm] = useState({ type: "", number: "", issuer: "", from: localToday(), until: "", cls: "", restriction: "" });
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void (async () => {
      const token = await getToken();
      if (!token) return;
      const r = await apiGet<SimperType[]>("/simper-types?status=ACTIVE", token);
      if (r.ok) setTypes(r.data);
    })();
  }, [getToken]);
  const pickType = (tid: string) => {
    const t = types.find((x) => x.id === tid);
    setForm({ ...form, type: tid, until: form.until || (t ? suggestUntil(form.from, t.default_validity_months) : "") });
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.type) return setError("Pilih jenis SIMPER.");
    if (form.from > localToday()) return setError("Tanggal mulai berlaku tidak boleh di masa depan.");
    if (form.until && form.until < form.from) return setError("Berlaku sampai tidak boleh lebih awal dari tanggal mulai.");
    if (!form.cls) return setError("Pilih minimal satu kelas alat.");
    setBusy(true);
    setError(null);
    const token = await getToken();
    if (!token) return;
    let fileId: string | null = null;
    if (file) {
      const up = await uploadFile(token, file, "SIMPER_DOCUMENT");
      if (!up.ok) {
        setBusy(false);
        return setError(up.message);
      }
      fileId = up.file.id;
    }
    // otorisasi kelas alat pertama mengikuti masa berlaku SIMPER
    const r = await apiSend("POST", `/workers/${workerId}/simpers`, token, {
      simper_type_id: form.type,
      simper_number: form.number.trim() || null,
      issuer: form.issuer.trim() || null,
      valid_from: form.from,
      valid_until: form.until || null,
      file_id: fileId,
      authorizations: [
        {
          equipment_class_id: form.cls,
          valid_from: form.from,
          valid_until: form.until || null,
          restriction_note: form.restriction.trim() || null,
        },
      ],
    });
    setBusy(false);
    if (!r.ok) return setError(simperErrorMessage(r.error));
    onDone("SIMPER diajukan dan menunggu verifikasi.");
  };
  return (
    <form className="form card entity-form" onSubmit={submit} aria-label="Ajukan SIMPER">
      <h3>Ajukan SIMPER</h3>
      <label htmlFor={`${id}-type`}>
        Jenis SIMPER (wajib)
        <select id={`${id}-type`} required value={form.type} onChange={(e) => pickType(e.target.value)}>
          <option value="">Pilih…</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.code})
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={`${id}-num`}>
        Nomor SIMPER
        <input
          id={`${id}-num`}
          maxLength={100}
          value={form.number}
          onChange={(e) => setForm({ ...form, number: e.target.value })}
        />
      </label>
      <label htmlFor={`${id}-iss`}>
        Penerbit
        <input
          id={`${id}-iss`}
          maxLength={150}
          value={form.issuer}
          onChange={(e) => setForm({ ...form, issuer: e.target.value })}
        />
      </label>
      <label htmlFor={`${id}-from`}>
        Berlaku mulai (wajib)
        <input
          id={`${id}-from`}
          type="date"
          required
          max={localToday()}
          value={form.from}
          onChange={(e) => setForm({ ...form, from: e.target.value })}
        />
      </label>
      <label htmlFor={`${id}-until`}>
        Berlaku sampai (kosong = tanpa batas)
        <input id={`${id}-until`} type="date" value={form.until} onChange={(e) => setForm({ ...form, until: e.target.value })} />
      </label>
      <fieldset>
        <legend>Otorisasi kelas alat (minimal satu)</legend>
        <label htmlFor={`${id}-cls`}>
          Kelas alat (wajib)
          <select id={`${id}-cls`} required value={form.cls} onChange={(e) => setForm({ ...form, cls: e.target.value })}>
            <option value="">Pilih…</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={`${id}-restr`}>
          Pembatasan
          <input
            id={`${id}-restr`}
            maxLength={500}
            value={form.restriction}
            onChange={(e) => setForm({ ...form, restriction: e.target.value })}
          />
        </label>
        <p className="muted small-text">Kelas alat lain dapat ditambahkan setelah SIMPER tersimpan.</p>
      </fieldset>
      <label htmlFor={`${id}-file`}>
        Dokumen SIMPER (PDF maks 10 MB, foto maks 20 MB)
        <input
          id={`${id}-file`}
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/webp"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <span className="row-actions">
        <button type="submit" disabled={busy}>
          {busy ? "Menyimpan…" : "Ajukan"}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
          Batal
        </button>
      </span>
    </form>
  );
}

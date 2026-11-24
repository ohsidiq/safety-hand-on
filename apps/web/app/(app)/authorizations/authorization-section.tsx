"use client";

import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { apiGet, apiSend } from "@/lib/api";
import {
  AUTH_VALIDITY_BADGE,
  type AuthorizationType,
  authorizationErrorMessage,
  authStatusLabel,
  suspensionActions,
  validateAuthorizationInput,
  type WorkerAuthorization,
} from "@/lib/authorizations";
import { suggestUntil } from "@/lib/competencies";
import { uploadFile } from "@/lib/files";
import { useSession } from "@/lib/session";

const localToday = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

const ACTION_LABEL = {
  verify: "Verifikasi",
  reject: "Tolak",
  suspend: "Bekukan",
  reinstate: "Pulihkan",
  revoke: "Cabut",
} as const;
type Action = keyof typeof ACTION_LABEL;
const DONE: Record<Action, string> = {
  verify: "Otorisasi diverifikasi.",
  reject: "Otorisasi ditolak.",
  suspend: "Otorisasi dibekukan.",
  reinstate: "Otorisasi dipulihkan.",
  revoke: "Otorisasi dicabut.",
};

/**
 * Otorisasi Kerja seorang pekerja (bukan Permit To Work): daftar, ajukan beserta dokumen, verifikasi, pembekuan.
 * canSuspend = authorization.verify penuh (HSE Manager); server tetap memeriksa.
 */
export function AuthorizationSection({
  workerId,
  canEdit,
  canVerify,
  title = "Otorisasi Kerja",
}: {
  workerId: string;
  canEdit: boolean;
  canVerify: boolean;
  title?: string;
}) {
  const { getToken } = useSession();
  const [items, setItems] = useState<WorkerAuthorization[]>([]);
  const [state, setState] = useState<"loading" | "idle" | "error">("loading");
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const r = await apiGet<WorkerAuthorization[]>(`/workers/${workerId}/authorizations`, token);
    if (r.ok) setItems(r.data);
    setState(r.ok ? "idle" : "error");
  }, [getToken, workerId]);
  useEffect(() => {
    void load();
  }, [load]);
  const changed = (text: string) => {
    setMessage(text);
    setAdding(false);
    setOpen(null);
    void load();
  };

  return (
    <section className="card panel" aria-labelledby={`otorisasi-${workerId}`}>
      <h2 id={`otorisasi-${workerId}`}>{title}</h2>
      {message ? <p role="status">{message}</p> : null}
      {state === "loading" ? <p role="status">Memuat…</p> : null}
      {state === "error" ? <p role="alert">Otorisasi Kerja tidak dapat dimuat.</p> : null}
      {state === "idle" && items.length === 0 ? <p className="muted">Belum ada Otorisasi Kerja tercatat.</p> : null}
      {items.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Jenis</th>
                <th scope="col">Berlaku</th>
                <th scope="col">Status</th>
                <th scope="col">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <AuthorizationRow
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
            Ajukan Otorisasi Kerja
          </button>
        </p>
      ) : null}
      {adding ? <AddAuthorization workerId={workerId} onDone={changed} onCancel={() => setAdding(false)} /> : null}
    </section>
  );
}

function AuthorizationRow({
  item,
  expanded,
  onToggle,
  canEdit,
  canVerify,
  onChanged,
}: {
  item: WorkerAuthorization;
  expanded: boolean;
  onToggle: () => void;
  canEdit: boolean;
  canVerify: boolean;
  onChanged: (t: string) => void;
}) {
  return (
    <>
      <tr>
        <td>
          {item.authorization_type.name ?? "-"}
          <br />
          <span className="muted small-text">
            {item.authorization_number ?? "Tanpa nomor"}
            {item.work_scope ? ` · ${item.work_scope}` : ""}
          </span>
        </td>
        <td>
          {item.valid_from} s.d. {item.valid_until ?? "tanpa batas"}
        </td>
        <td>
          <span className={AUTH_VALIDITY_BADGE[item.validity_status]}>{authStatusLabel(item)}</span>
          {item.restriction_note ? <p className="small-text">Pembatasan: {item.restriction_note}</p> : null}
        </td>
        <td>
          <button type="button" className="secondary" aria-expanded={expanded} onClick={onToggle}>
            {expanded ? "Tutup" : "Rincian"}
          </button>
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={4}>
            <AuthorizationDetail item={item} canEdit={canEdit} canVerify={canVerify} onChanged={onChanged} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function AuthorizationDetail({
  item,
  canEdit,
  canVerify,
  onChanged,
}: {
  item: WorkerAuthorization;
  canEdit: boolean;
  canVerify: boolean;
  onChanged: (t: string) => void;
}) {
  const { getToken } = useSession();
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Action | "edit" | null>(null);
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState(item.valid_until ?? "");
  const [restriction, setRestriction] = useState(item.restriction_note ?? "");
  const revoked = item.suspension_status === "REVOKED";

  const send = async (path: string, body: unknown, done: string, method: "POST" | "PATCH" = "POST") => {
    setBusy(true);
    setError(null);
    const token = await getToken();
    if (!token) return;
    const r = await apiSend<WorkerAuthorization>(method, path, token, body, { ifMatch: item.version });
    setBusy(false);
    if (!r.ok) return setError(authorizationErrorMessage(r.error));
    onChanged(done);
  };
  const runAction = (a: Action) => {
    if (a === "verify") return void send(`/worker-authorizations/${item.id}/verify`, {}, DONE.verify);
    setReason("");
    setPending(a);
  };
  const openDoc = async () => {
    const token = await getToken();
    if (!token) return;
    const r = await apiGet<{ url: string }>(`/worker-authorizations/${item.id}/document-url`, token);
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
            <dd>{item.verified_by_name}</dd>
          </>
        ) : null}
        {item.rejection_reason ? (
          <>
            <dt>Alasan penolakan</dt>
            <dd>{item.rejection_reason}</dd>
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
              onClick={() => runAction(a)}
            >
              {ACTION_LABEL[a]}
            </button>
          ))}
          {canEdit && !revoked ? (
            <button type="button" className="secondary" onClick={() => setPending("edit")}>
              Ubah
            </button>
          ) : null}
        </span>
      ) : null}
      {pending && pending !== "edit" && pending !== "verify" ? (
        <form
          className="form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (!reason.trim()) return setError("Alasan wajib diisi.");
            void send(`/worker-authorizations/${item.id}/${pending}`, { reason: reason.trim() }, DONE[pending]);
          }}
        >
          {pending === "revoke" ? (
            <p className="muted small-text">Pencabutan bersifat akhir. Pekerja harus mengajukan otorisasi baru.</p>
          ) : null}
          <label htmlFor={`${id}-reason`}>
            Alasan {ACTION_LABEL[pending].toLowerCase()} (wajib)
            <input id={`${id}-reason`} required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <span className="row-actions">
            <button type="submit" disabled={busy}>
              {ACTION_LABEL[pending]}
            </button>
            <button type="button" className="secondary" onClick={() => setPending(null)}>
              Batal
            </button>
          </span>
        </form>
      ) : null}
      {pending === "edit" ? (
        <form
          className="form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (until && until < item.valid_from) return setError("Berlaku sampai tidak boleh lebih awal dari tanggal mulai.");
            void send(
              `/worker-authorizations/${item.id}`,
              { valid_until: until || null, restriction_note: restriction.trim() || null },
              "Otorisasi diubah dan menunggu verifikasi.",
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
          <label htmlFor={`${id}-restr`}>
            Pembatasan
            <input id={`${id}-restr`} maxLength={500} value={restriction} onChange={(e) => setRestriction(e.target.value)} />
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
    </div>
  );
}

function AddAuthorization({
  workerId,
  onDone,
  onCancel,
}: {
  workerId: string;
  onDone: (t: string) => void;
  onCancel: () => void;
}) {
  const { getToken } = useSession();
  const id = useId();
  const [types, setTypes] = useState<AuthorizationType[]>([]);
  const [typeId, setTypeId] = useState("");
  const [form, setForm] = useState({ number: "", issuer: "", scope: "", restriction: "", from: localToday(), until: "" });
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void (async () => {
      const token = await getToken();
      if (!token) return;
      const r = await apiGet<AuthorizationType[]>("/authorization-types?status=ACTIVE", token);
      if (r.ok) setTypes(r.data);
    })();
  }, [getToken]);
  const type = types.find((t) => t.id === typeId);
  const pick = (tid: string) => {
    setTypeId(tid);
    const t = types.find((x) => x.id === tid);
    if (t && !form.until) setForm({ ...form, until: suggestUntil(form.from, t.default_validity_months) });
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const invalid = validateAuthorizationInput(
      { type, valid_from: form.from, valid_until: form.until, work_scope: form.scope },
      localToday(),
    );
    if (invalid) return setError(invalid);
    setBusy(true);
    setError(null);
    const token = await getToken();
    if (!token) return;
    let fileId: string | null = null;
    if (file) {
      const up = await uploadFile(token, file, "AUTHORIZATION_DOCUMENT");
      if (!up.ok) {
        setBusy(false);
        return setError(up.message);
      }
      fileId = up.file.id;
    }
    const r = await apiSend("POST", `/workers/${workerId}/authorizations`, token, {
      authorization_type_id: typeId,
      authorization_number: form.number.trim() || null,
      issuer: form.issuer.trim() || null,
      work_scope: form.scope.trim() || null,
      restriction_note: form.restriction.trim() || null,
      valid_from: form.from,
      valid_until: form.until || null,
      file_id: fileId,
    });
    setBusy(false);
    if (!r.ok) return setError(authorizationErrorMessage(r.error));
    onDone("Otorisasi Kerja diajukan dan menunggu verifikasi.");
  };
  const field = (key: keyof typeof form, label: string, max: number) => (
    <label htmlFor={`${id}-${key}`}>
      {label}
      <input
        id={`${id}-${key}`}
        maxLength={max}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    </label>
  );
  return (
    <form className="form card entity-form" onSubmit={submit} aria-label="Ajukan Otorisasi Kerja">
      <h3>Ajukan Otorisasi Kerja</h3>
      <label htmlFor={`${id}-type`}>
        Jenis (wajib)
        <select id={`${id}-type`} required value={typeId} onChange={(e) => pick(e.target.value)}>
          <option value="">Pilih…</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.code})
            </option>
          ))}
        </select>
      </label>
      {field("number", "Nomor otorisasi", 100)}
      {field("issuer", "Penerbit", 150)}
      {field("scope", type?.requires_work_scope ? "Lingkup pekerjaan (wajib untuk jenis ini)" : "Lingkup pekerjaan", 500)}
      {field("restriction", "Pembatasan", 500)}
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
      <label htmlFor={`${id}-file`}>
        Dokumen (PDF maks 10 MB, foto maks 20 MB)
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

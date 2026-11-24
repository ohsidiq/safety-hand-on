"use client";

import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { apiGet, apiSend } from "@/lib/api";
import {
  type CompetencyCertificate,
  type CompetencyMaster,
  type CompetencySource,
  competencyErrorMessage,
  SOURCE_LABEL,
  suggestUntil,
  VALIDITY_BADGE,
  VALIDITY_LABEL,
  validateCompetencyInput,
  type WorkerCompetency,
} from "@/lib/competencies";
import { uploadFile } from "@/lib/files";
import { useSession } from "@/lib/session";

const localToday = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

/** Membuka URL unduh bertanda tangan (berumur pendek; tidak disimpan). */
export async function openCertificate(token: string, certId: string): Promise<string | null> {
  const r = await apiGet<{ url: string }>(`/competency-certificates/${certId}/download-url`, token);
  if (!r.ok) return r.code === "FILE_NOT_CLEAN" ? "Berkas belum lolos pemeriksaan." : "Sertifikat tidak dapat diunduh.";
  window.open(r.data.url, "_blank", "noopener,noreferrer");
  return null;
}

/**
 * Kompetensi seorang pekerja (UIUX WF003): daftar riwayat, catat baru beserta sertifikat, tambah sertifikat, verifikasi.
 * Dipakai di detail pekerja (petugas) dan di profil (pekerja, SELF).
 */
export function CompetencySection({
  workerId,
  canEdit,
  canVerify,
  title = "Kompetensi",
}: {
  workerId: string;
  canEdit: boolean;
  canVerify: boolean;
  title?: string;
}) {
  const { getToken } = useSession();
  const [items, setItems] = useState<WorkerCompetency[]>([]);
  const [state, setState] = useState<"loading" | "idle" | "error">("loading");
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const r = await apiGet<WorkerCompetency[]>(`/workers/${workerId}/competencies`, token);
    if (r.ok) setItems(r.data);
    setState(r.ok ? "idle" : "error");
  }, [getToken, workerId]);
  useEffect(() => {
    void load();
  }, [load]);

  const changed = (text: string) => {
    setMessage(text);
    setAdding(false);
    void load();
  };

  return (
    <section className="card panel" aria-labelledby={`kompetensi-${workerId}`}>
      <h2 id={`kompetensi-${workerId}`}>{title}</h2>
      {message ? <p role="status">{message}</p> : null}
      {state === "loading" ? <p role="status">Memuat…</p> : null}
      {state === "error" ? <p role="alert">Kompetensi tidak dapat dimuat.</p> : null}
      {state === "idle" && items.length === 0 ? <p className="muted">Belum ada kompetensi tercatat.</p> : null}
      {items.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Kompetensi</th>
                <th scope="col">Berlaku</th>
                <th scope="col">Status</th>
                <th scope="col">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <CompetencyRow
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
            Catat kompetensi
          </button>
        </p>
      ) : null}
      {adding ? <AddCompetency workerId={workerId} onDone={changed} onCancel={() => setAdding(false)} /> : null}
    </section>
  );
}

function CompetencyRow({
  item,
  expanded,
  onToggle,
  canEdit,
  canVerify,
  onChanged,
}: {
  item: WorkerCompetency;
  expanded: boolean;
  onToggle: () => void;
  canEdit: boolean;
  canVerify: boolean;
  onChanged: (text: string) => void;
}) {
  return (
    <>
      <tr>
        <td>
          {item.competency.name ?? "-"}
          <br />
          <span className="muted small-text">
            {item.competency.code} · {SOURCE_LABEL[item.source]}
          </span>
        </td>
        <td>
          {item.valid_from} s.d. {item.valid_until ?? "tanpa batas"}
        </td>
        <td>
          <span className={VALIDITY_BADGE[item.validity_status]}>{VALIDITY_LABEL[item.validity_status]}</span>
          {item.rejection_reason ? <p className="small-text">Alasan: {item.rejection_reason}</p> : null}
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
            <CompetencyDetail item={item} canEdit={canEdit} canVerify={canVerify} onChanged={onChanged} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function CompetencyDetail({
  item,
  canEdit,
  canVerify,
  onChanged,
}: {
  item: WorkerCompetency;
  canEdit: boolean;
  canVerify: boolean;
  onChanged: (text: string) => void;
}) {
  const { getToken } = useSession();
  const [certs, setCerts] = useState<CompetencyCertificate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"view" | "reject" | "edit" | "cert">("view");
  const [text, setText] = useState("");
  const [until, setUntil] = useState(item.valid_until ?? "");
  const id = useId();

  useEffect(() => {
    void (async () => {
      const token = await getToken();
      if (!token) return;
      const r = await apiGet<CompetencyCertificate[]>(`/worker-competencies/${item.id}/certificates`, token);
      if (r.ok) setCerts(r.data);
    })();
  }, [getToken, item.id]);

  const act = async (path: string, body: unknown, done: string, method: "POST" | "PATCH" = "POST") => {
    setBusy(true);
    setError(null);
    const token = await getToken();
    if (!token) return;
    const r = await apiSend<WorkerCompetency>(method, path, token, body, { ifMatch: item.version });
    setBusy(false);
    if (!r.ok) {
      setError(competencyErrorMessage(r.error));
      return;
    }
    onChanged(done);
  };
  const download = async (certId: string) => {
    const token = await getToken();
    if (!token) return;
    setError(await openCertificate(token, certId));
  };
  const verifiable = canVerify && item.can_verify;

  return (
    <div className="stack">
      <dl className="facts">
        <dt>Dicatat oleh</dt>
        <dd>{item.created_by_name ?? "-"}</dd>
        {item.verified_by_name ? (
          <>
            <dt>{item.verification_status === "REJECTED" ? "Ditolak oleh" : "Diverifikasi oleh"}</dt>
            <dd>
              {item.verified_by_name}
              {item.verified_at ? ` · ${item.verified_at.slice(0, 10)}` : ""}
            </dd>
          </>
        ) : null}
        {item.verification_comment ? (
          <>
            <dt>Catatan verifikasi</dt>
            <dd>{item.verification_comment}</dd>
          </>
        ) : null}
      </dl>
      <h3>Sertifikat</h3>
      {certs.length === 0 ? <p className="muted">Belum ada sertifikat.</p> : null}
      <ul>
        {certs.map((c) => (
          <li key={c.id}>
            {c.certificate_number ?? "Tanpa nomor"} · {c.issuer ?? "-"} · terbit {c.issue_date}
            {c.expiry_date ? ` · kedaluwarsa ${c.expiry_date}` : ""}{" "}
            {c.file_id ? (
              <button type="button" className="secondary" onClick={() => void download(c.id)}>
                Unduh
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {mode === "view" ? (
        <span className="row-actions">
          {verifiable ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(`/worker-competencies/${item.id}/verify`, {}, "Kompetensi diverifikasi.")}
              >
                Verifikasi
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => setMode("reject")}>
                Tolak
              </button>
            </>
          ) : null}
          {canVerify && item.verification_status === "PENDING" && !item.can_verify ? (
            <span className="muted small-text">Data yang Anda catat diverifikasi orang lain.</span>
          ) : null}
          {canEdit ? (
            <>
              <button type="button" className="secondary" onClick={() => setMode("edit")}>
                Ubah masa berlaku
              </button>
              <button type="button" className="secondary" onClick={() => setMode("cert")}>
                Tambah sertifikat
              </button>
            </>
          ) : null}
        </span>
      ) : null}
      {mode === "reject" ? (
        <form
          className="form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (!text.trim()) return setError("Alasan penolakan wajib diisi.");
            void act(`/worker-competencies/${item.id}/reject`, { reason: text.trim() }, "Kompetensi ditolak.");
          }}
        >
          <label htmlFor={`${id}-reason`}>
            Alasan penolakan (wajib)
            <input id={`${id}-reason`} required maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          <span className="row-actions">
            <button type="submit" disabled={busy}>
              Tolak
            </button>
            <button type="button" className="secondary" onClick={() => setMode("view")}>
              Batal
            </button>
          </span>
        </form>
      ) : null}
      {mode === "edit" ? (
        <form
          className="form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (until && until < item.valid_from) return setError("Berlaku sampai tidak boleh lebih awal dari tanggal mulai.");
            void act(
              `/worker-competencies/${item.id}`,
              { valid_until: until || null },
              "Masa berlaku diubah dan menunggu verifikasi.",
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
            <button type="button" className="secondary" onClick={() => setMode("view")}>
              Batal
            </button>
          </span>
        </form>
      ) : null}
      {mode === "cert" ? (
        <AddCertificate
          wcId={item.id}
          resubmits={item.verification_status !== "PENDING"}
          onDone={() => onChanged("Sertifikat ditambahkan dan menunggu verifikasi.")}
          onCancel={() => setMode("view")}
        />
      ) : null}
    </div>
  );
}

function CertificateFields({
  value,
  onChange,
  onFile,
}: {
  value: { number: string; issuer: string; issue: string; expiry: string };
  onChange: (v: { number: string; issuer: string; issue: string; expiry: string }) => void;
  onFile: (f: File | null) => void;
}) {
  const id = useId();
  return (
    <fieldset>
      <legend>Sertifikat</legend>
      <label htmlFor={`${id}-file`}>
        Berkas (PDF maks 10 MB, foto maks 20 MB)
        <input
          id={`${id}-file`}
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/webp"
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        />
      </label>
      <label htmlFor={`${id}-num`}>
        Nomor sertifikat
        <input
          id={`${id}-num`}
          maxLength={100}
          value={value.number}
          onChange={(e) => onChange({ ...value, number: e.target.value })}
        />
      </label>
      <label htmlFor={`${id}-issuer`}>
        Penerbit
        <input
          id={`${id}-issuer`}
          maxLength={150}
          value={value.issuer}
          onChange={(e) => onChange({ ...value, issuer: e.target.value })}
        />
      </label>
      <label htmlFor={`${id}-issue`}>
        Tanggal terbit
        <input
          id={`${id}-issue`}
          type="date"
          value={value.issue}
          onChange={(e) => onChange({ ...value, issue: e.target.value })}
        />
      </label>
      <label htmlFor={`${id}-exp`}>
        Tanggal kedaluwarsa
        <input
          id={`${id}-exp`}
          type="date"
          value={value.expiry}
          onChange={(e) => onChange({ ...value, expiry: e.target.value })}
        />
      </label>
    </fieldset>
  );
}

const EMPTY_CERT = { number: "", issuer: "", issue: "", expiry: "" };

function AddCertificate({
  wcId,
  resubmits,
  onDone,
  onCancel,
}: {
  wcId: string;
  resubmits: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { getToken } = useSession();
  const [cert, setCert] = useState(EMPTY_CERT);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return setError("Pilih berkas sertifikat.");
    if (!cert.issue) return setError("Tanggal terbit sertifikat wajib diisi.");
    if (cert.expiry && cert.expiry < cert.issue) return setError("Tanggal kedaluwarsa lebih awal dari tanggal terbit.");
    setBusy(true);
    setError(null);
    const token = await getToken();
    if (!token) return;
    const up = await uploadFile(token, file, "COMPETENCY_CERTIFICATE");
    if (!up.ok) {
      setBusy(false);
      return setError(up.message);
    }
    const r = await apiSend("POST", `/worker-competencies/${wcId}/certificates`, token, {
      certificate_number: cert.number.trim() || null,
      issuer: cert.issuer.trim() || null,
      issue_date: cert.issue,
      expiry_date: cert.expiry || null,
      file_id: up.file.id,
    });
    setBusy(false);
    if (!r.ok) return setError(competencyErrorMessage(r.error));
    onDone();
  };
  return (
    <form className="form" onSubmit={submit} aria-label="Tambah sertifikat">
      {resubmits ? <p className="muted small-text">Sertifikat baru mengembalikan status ke Menunggu verifikasi.</p> : null}
      <CertificateFields value={cert} onChange={setCert} onFile={setFile} />
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <span className="row-actions">
        <button type="submit" disabled={busy}>
          {busy ? "Mengunggah…" : "Simpan sertifikat"}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
          Batal
        </button>
      </span>
    </form>
  );
}

function AddCompetency({ workerId, onDone, onCancel }: { workerId: string; onDone: (t: string) => void; onCancel: () => void }) {
  const { getToken } = useSession();
  const id = useId();
  const [masters, setMasters] = useState<CompetencyMaster[]>([]);
  const [competencyId, setCompetencyId] = useState("");
  const [from, setFrom] = useState(localToday());
  const [until, setUntil] = useState("");
  const [source, setSource] = useState<CompetencySource>("CERTIFICATE");
  const [cert, setCert] = useState(EMPTY_CERT);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const token = await getToken();
      if (!token) return;
      const r = await apiGet<CompetencyMaster[]>("/competencies?status=ACTIVE", token);
      if (r.ok) setMasters(r.data);
    })();
  }, [getToken]);

  const pick = (cid: string) => {
    setCompetencyId(cid);
    const m = masters.find((x) => x.id === cid);
    if (m && !until) setUntil(suggestUntil(from, m.default_validity_months));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const invalid = validateCompetencyInput(
      { competency_id: competencyId, valid_from: from, valid_until: until, issue_date: cert.issue, expiry_date: cert.expiry },
      localToday(),
      file !== null,
    );
    if (invalid) return setError(invalid);
    setBusy(true);
    setError(null);
    const token = await getToken();
    if (!token) return;
    const certificates: unknown[] = [];
    if (file) {
      const up = await uploadFile(token, file, "COMPETENCY_CERTIFICATE");
      if (!up.ok) {
        setBusy(false);
        return setError(up.message);
      }
      certificates.push({
        certificate_number: cert.number.trim() || null,
        issuer: cert.issuer.trim() || null,
        issue_date: cert.issue,
        expiry_date: cert.expiry || null,
        file_id: up.file.id,
      });
    }
    const r = await apiSend("POST", `/workers/${workerId}/competencies`, token, {
      competency_id: competencyId,
      valid_from: from,
      valid_until: until || null,
      source,
      certificates,
    });
    setBusy(false);
    if (!r.ok) return setError(competencyErrorMessage(r.error));
    onDone("Kompetensi dicatat dan menunggu verifikasi.");
  };

  return (
    <form className="form card entity-form" onSubmit={submit} aria-label="Catat kompetensi">
      <h3>Catat kompetensi</h3>
      <label htmlFor={`${id}-c`}>
        Kompetensi (wajib)
        <select id={`${id}-c`} required value={competencyId} onChange={(e) => pick(e.target.value)}>
          <option value="">Pilih…</option>
          {masters.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.code})
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={`${id}-src`}>
        Sumber
        <select id={`${id}-src`} value={source} onChange={(e) => setSource(e.target.value as CompetencySource)}>
          {(Object.keys(SOURCE_LABEL) as CompetencySource[]).map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={`${id}-from`}>
        Berlaku mulai (wajib)
        <input id={`${id}-from`} type="date" required max={localToday()} value={from} onChange={(e) => setFrom(e.target.value)} />
      </label>
      <label htmlFor={`${id}-until`}>
        Berlaku sampai (kosong = tanpa batas)
        <input id={`${id}-until`} type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
      </label>
      <CertificateFields value={cert} onChange={setCert} onFile={setFile} />
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

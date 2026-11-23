"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { apiGet, apiSend } from "@/lib/api";
import { useMe, useSession } from "@/lib/session";
import {
  type Assignment,
  type ContractorOption,
  contractorsForSite,
  EMPLOYMENT_LABEL,
  type EmploymentStatus,
  STATUS_ACTIONS,
  type StatusAction,
  validateWorkerInput,
  WORKER_STATUS_LABEL,
  type Worker,
  workerErrorMessage,
} from "@/lib/workers";
import { EMPTY_PLACEMENT, type Placement, PlacementFields } from "../placement-fields";

/** Detail pekerja (UIUX-005 §4): ringkasan, ubah data, aksi status beralasan, riwayat penempatan. */
export function WorkerDetailView({ id }: { id: string }) {
  const { me } = useMe();
  const { getToken } = useSession();
  const [worker, setWorker] = useState<Worker | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [state, setState] = useState<"loading" | "idle" | "missing" | "error">("loading");
  const [mode, setMode] = useState<"view" | "edit" | "assign" | StatusAction>("view");
  const [message, setMessage] = useState<string | null>(null);
  const can = (p: string) => me.permissions.includes(p);
  const allowed = can("worker.read");

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const [w, a] = await Promise.all([
      apiGet<Worker>(`/workers/${id}`, token),
      apiGet<Assignment[]>(`/workers/${id}/assignments`, token),
    ]);
    if (!w.ok) {
      setState(w.status === 404 || w.status === 422 ? "missing" : "error");
      return;
    }
    setWorker(w.data);
    if (a.ok) setAssignments(a.data);
    setState("idle");
  }, [getToken, id]);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  if (!allowed) return <p role="alert">Anda tidak berwenang membuka halaman ini.</p>;
  if (state === "loading") return <p role="status">Memuat…</p>;
  if (state === "missing") return <p role="alert">Pekerja tidak ditemukan atau di luar cakupan Anda.</p>;
  if (state === "error" || !worker) return <p role="alert">Data pekerja tidak dapat dimuat. Coba lagi.</p>;

  const done = (w: Worker, text: string) => {
    setWorker(w);
    setMode("view");
    setMessage(text);
    void load();
  };
  const final = worker.worker_status === "RESIGNED";

  return (
    <>
      <p>
        <Link href="/workers">← Daftar pekerja</Link>
      </p>
      <h1>{worker.full_name}</h1>
      {message ? <p role="status">{message}</p> : null}
      <section className="card panel" aria-labelledby="ringkasan">
        <h2 id="ringkasan">Ringkasan</h2>
        <dl className="facts">
          <dt>SHO ID</dt>
          <dd>{worker.sho_id}</dd>
          <dt>Nomor pekerja</dt>
          <dd>{worker.employee_number}</dd>
          <dt>Status</dt>
          <dd>{WORKER_STATUS_LABEL[worker.worker_status]}</dd>
          <dt>Status kerja</dt>
          <dd>
            {EMPLOYMENT_LABEL[worker.employment_status]}
            {worker.contractor ? ` · ${worker.contractor.name ?? "kontraktor"}` : ""}
          </dd>
          <dt>Posisi</dt>
          <dd>{worker.job_position?.name ?? "-"}</dd>
          <dt>Site</dt>
          <dd>{worker.site?.name ?? "-"}</dd>
          <dt>Department</dt>
          <dd>
            {worker.department?.name ?? "-"}
            {worker.division ? ` · ${worker.division.name}` : ""}
          </dd>
          <dt>Tanggal masuk</dt>
          <dd>{worker.join_date}</dd>
          {worker.exit_date ? (
            <>
              <dt>Tanggal berhenti</dt>
              <dd>{worker.exit_date}</dd>
            </>
          ) : null}
          <dt>Telepon</dt>
          <dd>{worker.phone ?? "-"}</dd>
          <dt>Email</dt>
          <dd>{worker.email ?? "-"}</dd>
          <dt>NIK</dt>
          <dd>{worker.has_national_id ? "Tersimpan (tidak ditampilkan)" : "Belum diisi"}</dd>
          <dt>Akun aplikasi</dt>
          <dd>{worker.has_account ? "Terhubung" : "Belum ada"}</dd>
        </dl>
        <p className="muted small-text">Status kesiapan tampil setelah modul Readiness aktif.</p>
        {final ? <p className="muted">Pekerja sudah berhenti. Data tidak dapat diubah.</p> : null}
        {!final && mode === "view" ? (
          <span className="row-actions">
            {can("worker.update") ? (
              <>
                <button type="button" className="secondary small" onClick={() => setMode("edit")}>
                  Ubah data
                </button>
                {worker.worker_status === "ACTIVE" || worker.worker_status === "SUSPENDED" ? (
                  <button type="button" className="secondary small" onClick={() => setMode("assign")}>
                    Penempatan baru
                  </button>
                ) : null}
              </>
            ) : null}
            {can("worker.deactivate")
              ? STATUS_ACTIONS[worker.worker_status].map((a) => (
                  <button key={a.action} type="button" className="secondary small" onClick={() => setMode(a.action)}>
                    {a.label}
                  </button>
                ))
              : null}
          </span>
        ) : null}
      </section>
      {mode === "edit" ? (
        <EditForm worker={worker} onCancel={() => setMode("view")} onSaved={(w) => done(w, "Data pekerja disimpan.")} />
      ) : null}
      {mode === "assign" ? (
        <AssignForm worker={worker} onCancel={() => setMode("view")} onSaved={(w) => done(w, "Penempatan baru disimpan.")} />
      ) : null}
      {mode !== "view" && mode !== "edit" && mode !== "assign" ? (
        <StatusForm
          worker={worker}
          action={mode}
          onCancel={() => setMode("view")}
          onSaved={(w) => done(w, `Status pekerja sekarang: ${WORKER_STATUS_LABEL[w.worker_status]}.`)}
        />
      ) : null}
      <section className="card panel" aria-labelledby="penempatan">
        <h2 id="penempatan">Riwayat penempatan</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Mulai</th>
                <th>Sampai</th>
                <th>Site</th>
                <th>Department</th>
                <th>Posisi</th>
                <th>Alasan</th>
              </tr>
            </thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={a.id}>
                  <td className="nowrap">{a.effective_from}</td>
                  <td className="nowrap">{a.current ? "Saat ini" : (a.effective_until ?? "-")}</td>
                  <td>{a.site?.name ?? "-"}</td>
                  <td>{a.department?.name ?? "-"}</td>
                  <td>{a.job_position?.name ?? "-"}</td>
                  <td>{a.reason === "INITIAL" ? "Penempatan awal" : a.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function EditForm({ worker, onCancel, onSaved }: { worker: Worker; onCancel: () => void; onSaved: (w: Worker) => void }) {
  const { me } = useMe();
  const { getToken } = useSession();
  const id = useId();
  const [v, setV] = useState({
    full_name: worker.full_name,
    phone: worker.phone ?? "",
    email: worker.email ?? "",
    national_id: "",
    employment_status: worker.employment_status,
    contractor_id: worker.contractor?.id ?? "",
  });
  const [contractors, setContractors] = useState<ContractorOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!me.permissions.includes("contractor.read")) return;
    void (async () => {
      const token = await getToken();
      if (!token) return;
      const r = await apiGet<ContractorOption[]>("/contractors?status=ACTIVE", token);
      if (r.ok) setContractors(r.data);
    })();
  }, [getToken, me.permissions]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const invalid = validateWorkerInput({ full_name: v.full_name, phone: v.phone, email: v.email, national_id: v.national_id });
    if (invalid) {
      setError(invalid);
      return;
    }
    const body: Record<string, unknown> = {};
    if (v.full_name.trim() !== worker.full_name) body.full_name = v.full_name.trim();
    if (v.phone.trim() !== (worker.phone ?? "")) body.phone = v.phone.trim() || null;
    if (v.email.trim() !== (worker.email ?? "")) body.email = v.email.trim() || null;
    if (v.national_id.trim()) body.national_id = v.national_id.replace(/[\s-]/g, "");
    if (v.employment_status !== worker.employment_status) body.employment_status = v.employment_status;
    const ctr = v.employment_status === "CONTRACTOR" ? v.contractor_id || null : null;
    if (ctr !== (worker.contractor?.id ?? null)) body.contractor_id = ctr;
    if (Object.keys(body).length === 0) {
      onCancel();
      return;
    }
    const token = await getToken();
    if (!token) return;
    setBusy(true);
    const r = await apiSend<Worker>("PATCH", `/workers/${worker.id}`, token, body, { ifMatch: worker.version });
    setBusy(false);
    if (!r.ok) {
      setError(workerErrorMessage(r.error));
      return;
    }
    onSaved(r.data);
  }

  const options = worker.site ? contractorsForSite(contractors, worker.site.id) : [];
  return (
    <form className="form card entity-form" onSubmit={submit} aria-label="Ubah data pekerja">
      <h3>Ubah data</h3>
      <label htmlFor={`${id}-name`}>
        Nama lengkap (wajib)
        <input
          id={`${id}-name`}
          required
          maxLength={150}
          value={v.full_name}
          onChange={(e) => setV({ ...v, full_name: e.target.value })}
        />
      </label>
      <label htmlFor={`${id}-phone`}>
        Telepon
        <input
          id={`${id}-phone`}
          type="tel"
          maxLength={16}
          value={v.phone}
          onChange={(e) => setV({ ...v, phone: e.target.value })}
        />
      </label>
      <label htmlFor={`${id}-email`}>
        Email
        <input
          id={`${id}-email`}
          type="email"
          maxLength={254}
          value={v.email}
          onChange={(e) => setV({ ...v, email: e.target.value })}
        />
      </label>
      <label htmlFor={`${id}-nik`}>
        {worker.has_national_id ? "Ganti NIK" : "NIK"}
        <input
          id={`${id}-nik`}
          inputMode="numeric"
          autoComplete="off"
          maxLength={20}
          value={v.national_id}
          onChange={(e) => setV({ ...v, national_id: e.target.value })}
        />
        <span className="muted small-text">Kosongkan bila tidak diubah. Nilai tersimpan tidak pernah ditampilkan.</span>
      </label>
      <label htmlFor={`${id}-emp`}>
        Status kerja
        <select
          id={`${id}-emp`}
          value={v.employment_status}
          onChange={(e) => setV({ ...v, employment_status: e.target.value as EmploymentStatus })}
        >
          {(Object.keys(EMPLOYMENT_LABEL) as EmploymentStatus[]).map((s) => (
            <option key={s} value={s}>
              {EMPLOYMENT_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      {v.employment_status === "CONTRACTOR" ? (
        <label htmlFor={`${id}-ctr`}>
          Kontraktor (wajib)
          <select
            id={`${id}-ctr`}
            required
            value={v.contractor_id}
            onChange={(e) => setV({ ...v, contractor_id: e.target.value })}
          >
            <option value="">Pilih kontraktor</option>
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.code})
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <p className="muted small-text">Site, department, dan posisi diubah lewat Penempatan baru.</p>
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

const STATUS_TITLE: Record<StatusAction, string> = {
  suspend: "Skors pekerja",
  reinstate: "Akhiri skorsing",
  deactivate: "Nonaktifkan pekerja",
  reactivate: "Aktifkan kembali pekerja",
  resign: "Catat pekerja berhenti",
};

function StatusForm(props: { worker: Worker; action: StatusAction; onCancel: () => void; onSaved: (w: Worker) => void }) {
  const { worker, action, onCancel, onSaved } = props;
  const { getToken } = useSession();
  const id = useId();
  const [reason, setReason] = useState("");
  const [exitDate, setExitDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 3) {
      setError("Alasan wajib diisi (minimal 3 karakter).");
      return;
    }
    const token = await getToken();
    if (!token) return;
    setBusy(true);
    const body: Record<string, unknown> = { reason: reason.trim() };
    if (action === "resign") body.exit_date = exitDate;
    const r = await apiSend<Worker>("POST", `/workers/${worker.id}/${action}`, token, body, { ifMatch: worker.version });
    setBusy(false);
    if (!r.ok) {
      setError(workerErrorMessage(r.error));
      return;
    }
    onSaved(r.data);
  }

  return (
    <form className="form card entity-form" onSubmit={submit} aria-label={STATUS_TITLE[action]}>
      <h3>{STATUS_TITLE[action]}</h3>
      {action === "deactivate" || action === "resign" ? (
        <p className="notice">Akun aplikasi pekerja ini (bila ada) ikut dinonaktifkan.</p>
      ) : null}
      {action === "resign" ? <p className="notice">Status berhenti bersifat akhir dan tidak dapat dibatalkan.</p> : null}
      <label htmlFor={`${id}-reason`}>
        Alasan (wajib)
        <textarea
          id={`${id}-reason`}
          required
          maxLength={500}
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      {action === "resign" ? (
        <label htmlFor={`${id}-exit`}>
          Tanggal berhenti (wajib)
          <input id={`${id}-exit`} type="date" required value={exitDate} onChange={(e) => setExitDate(e.target.value)} />
        </label>
      ) : null}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <span className="row-actions">
        <button type="submit" className={action === "resign" || action === "deactivate" ? "danger" : undefined} disabled={busy}>
          {busy ? "Menyimpan…" : "Konfirmasi"}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
          Batal
        </button>
      </span>
    </form>
  );
}

function AssignForm({ worker, onCancel, onSaved }: { worker: Worker; onCancel: () => void; onSaved: (w: Worker) => void }) {
  const { getToken } = useSession();
  const id = useId();
  const [placement, setPlacement] = useState<Placement>({
    ...EMPTY_PLACEMENT,
    site_id: worker.site?.id ?? "",
    department_id: worker.department?.id ?? "",
    job_position_id: worker.job_position?.id ?? "",
  });
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 3) {
      setError("Alasan wajib diisi (minimal 3 karakter).");
      return;
    }
    const token = await getToken();
    if (!token) return;
    setBusy(true);
    const body: Record<string, unknown> = {
      site_id: placement.site_id,
      department_id: placement.department_id,
      job_position_id: placement.job_position_id,
      effective_from: from,
      reason: reason.trim(),
    };
    if (placement.division_id) body.division_id = placement.division_id;
    const r = await apiSend<Worker>("POST", `/workers/${worker.id}/assignments`, token, body);
    setBusy(false);
    if (!r.ok) {
      setError(workerErrorMessage(r.error));
      return;
    }
    onSaved(r.data);
  }

  return (
    <form className="form card entity-form" onSubmit={submit} aria-label="Penempatan baru">
      <h3>Penempatan baru</h3>
      <p className="muted small-text">Penempatan saat ini ditutup sehari sebelum tanggal berlaku. Riwayat tetap tersimpan.</p>
      <PlacementFields value={placement} onChange={setPlacement} />
      <label htmlFor={`${id}-from`}>
        Berlaku mulai (wajib)
        <input id={`${id}-from`} type="date" required value={from} onChange={(e) => setFrom(e.target.value)} />
      </label>
      <label htmlFor={`${id}-reason`}>
        Alasan (wajib)
        <input id={`${id}-reason`} required maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <span className="row-actions">
        <button type="submit" disabled={busy}>
          {busy ? "Menyimpan…" : "Simpan penempatan"}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
          Batal
        </button>
      </span>
    </form>
  );
}

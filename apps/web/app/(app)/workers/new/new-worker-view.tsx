"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useState } from "react";
import { apiGet, apiSend } from "@/lib/api";
import { useMe, useSession } from "@/lib/session";
import {
  type ContractorOption,
  contractorsForSite,
  EMPLOYMENT_LABEL,
  type EmploymentStatus,
  validateWorkerInput,
  type Worker,
  workerErrorMessage,
} from "@/lib/workers";
import { EMPTY_PLACEMENT, type Placement, PlacementFields } from "../placement-fields";

/** Form pembuatan pekerja (UIUX-005 §4, API-003 §2). Pekerja kontraktor wajib memilih kontraktor (BR-G-039). */
export function NewWorkerView() {
  const { me } = useMe();
  const { getToken } = useSession();
  const router = useRouter();
  const id = useId();
  const allowed = me.permissions.includes("worker.create");
  const [v, setV] = useState({
    employee_number: "",
    full_name: "",
    phone: "",
    email: "",
    national_id: "",
    employment_status: "PERMANENT" as EmploymentStatus,
    contractor_id: "",
    join_date: new Date().toISOString().slice(0, 10),
  });
  const [placement, setPlacement] = useState<Placement>(EMPTY_PLACEMENT);
  const [contractors, setContractors] = useState<ContractorOption[]>([]);
  const [dupWarning, setDupWarning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!allowed || !me.permissions.includes("contractor.read")) return;
    void (async () => {
      const token = await getToken();
      if (!token) return;
      const r = await apiGet<ContractorOption[]>("/contractors?status=ACTIVE", token);
      if (r.ok) setContractors(r.data);
    })();
  }, [allowed, getToken, me.permissions]);

  if (!allowed) return <p role="alert">Anda tidak berwenang membuka halaman ini.</p>;

  const options = placement.site_id ? contractorsForSite(contractors, placement.site_id) : [];

  async function checkDuplicate() {
    const n = v.employee_number.trim();
    if (n.length < 3) return;
    const token = await getToken();
    if (!token) return;
    const r = await apiGet<{ exists: boolean }>(`/workers/duplicate-check?employee_number=${encodeURIComponent(n)}`, token);
    setDupWarning(r.ok && r.data.exists);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const invalid = validateWorkerInput(v);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (v.employment_status === "CONTRACTOR" && !v.contractor_id) {
      setError("Pekerja kontraktor wajib memilih kontraktor.");
      return;
    }
    const body: Record<string, unknown> = {
      employee_number: v.employee_number.trim(),
      full_name: v.full_name.trim(),
      employment_status: v.employment_status,
      join_date: v.join_date,
      site_id: placement.site_id,
      department_id: placement.department_id,
      job_position_id: placement.job_position_id,
    };
    if (placement.division_id) body.division_id = placement.division_id;
    if (v.phone.trim()) body.phone = v.phone.trim();
    if (v.email.trim()) body.email = v.email.trim();
    if (v.national_id.trim()) body.national_id = v.national_id.replace(/[\s-]/g, "");
    if (v.employment_status === "CONTRACTOR") body.contractor_id = v.contractor_id;
    const token = await getToken();
    if (!token) return;
    setBusy(true);
    const r = await apiSend<Worker>("POST", "/workers", token, body);
    setBusy(false);
    if (!r.ok) {
      setError(workerErrorMessage(r.error));
      return;
    }
    // NIK dikosongkan dari memori form segera setelah tersimpan
    setV((prev) => ({ ...prev, national_id: "" }));
    router.push(`/workers/${r.data.id}`);
  }

  const field = (key: keyof typeof v, label: string, props: Record<string, unknown> = {}) => (
    <label htmlFor={`${id}-${key}`}>
      {label}
      <input id={`${id}-${key}`} value={v[key]} onChange={(e) => setV({ ...v, [key]: e.target.value })} {...props} />
    </label>
  );

  return (
    <form className="form card entity-form" onSubmit={submit} aria-label="Data pekerja baru">
      <label htmlFor={`${id}-employee_number`}>
        Nomor pekerja (wajib)
        <input
          id={`${id}-employee_number`}
          required
          maxLength={30}
          value={v.employee_number}
          onChange={(e) => {
            setV({ ...v, employee_number: e.target.value });
            setDupWarning(false);
          }}
          onBlur={checkDuplicate}
        />
      </label>
      {dupWarning ? (
        <p className="error" role="alert">
          Nomor pekerja ini sudah dipakai.
        </p>
      ) : null}
      {field("full_name", "Nama lengkap (wajib)", { required: true, maxLength: 150 })}
      {field("phone", "Telepon", { type: "tel", placeholder: "+6281234567890", maxLength: 16 })}
      {field("email", "Email", { type: "email", maxLength: 254 })}
      <label htmlFor={`${id}-national_id`}>
        NIK
        <input
          id={`${id}-national_id`}
          inputMode="numeric"
          autoComplete="off"
          maxLength={20}
          value={v.national_id}
          onChange={(e) => setV({ ...v, national_id: e.target.value })}
        />
        <span className="muted small-text">Disimpan terenkripsi dan tidak akan ditampilkan lagi. Gunakan data sintetis.</span>
      </label>
      <label htmlFor={`${id}-employment_status`}>
        Status kerja (wajib)
        <select
          id={`${id}-employment_status`}
          value={v.employment_status}
          onChange={(e) => setV({ ...v, employment_status: e.target.value as EmploymentStatus, contractor_id: "" })}
        >
          {(Object.keys(EMPLOYMENT_LABEL) as EmploymentStatus[]).map((s) => (
            <option key={s} value={s}>
              {EMPLOYMENT_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      {field("join_date", "Tanggal masuk (wajib)", { type: "date", required: true })}
      <PlacementFields
        value={placement}
        onChange={(p) => {
          setPlacement(p);
          if (p.site_id !== placement.site_id) setV((prev) => ({ ...prev, contractor_id: "" }));
        }}
      />
      {v.employment_status === "CONTRACTOR" ? (
        <label htmlFor={`${id}-contractor`}>
          Kontraktor (wajib)
          <select
            id={`${id}-contractor`}
            required
            disabled={!placement.site_id}
            value={v.contractor_id}
            onChange={(e) => setV({ ...v, contractor_id: e.target.value })}
          >
            <option value="">{placement.site_id ? "Pilih kontraktor" : "Pilih Site dulu"}</option>
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.code})
              </option>
            ))}
          </select>
          {placement.site_id && options.length === 0 ? (
            <span className="muted small-text">Tidak ada kontraktor aktif yang terhubung ke Site ini.</span>
          ) : null}
        </label>
      ) : null}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <span className="row-actions">
        <button type="submit" disabled={busy}>
          {busy ? "Menyimpan…" : "Simpan pekerja"}
        </button>
        <button type="button" className="secondary" onClick={() => router.push("/workers")} disabled={busy}>
          Batal
        </button>
      </span>
    </form>
  );
}

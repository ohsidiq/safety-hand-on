"use client";

import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { ROLE_LABEL, SCOPE_LABEL } from "@/lib/nav";
import { useMe, useSession } from "@/lib/session";
import { EMPLOYMENT_LABEL, WORKER_STATUS_LABEL, type Worker } from "@/lib/workers";
import { AuthorizationSection } from "../authorizations/authorization-section";
import { CompetencySection } from "../competencies/competency-section";
import { MedicalSection } from "../medical/medical-section";
import { SimperSection } from "../simpers/simper-section";
import { ReadinessSection } from "../workers/[id]/readiness-section";
import { PassportCard } from "./passport-card";

/** Data pekerja milik akun (B-18, PB-009 worker.read S). Hanya baca; NIK tidak pernah ditampilkan. */
function MyWorker() {
  const { getToken } = useSession();
  const [w, setW] = useState<Worker | null>(null);
  const [state, setState] = useState<"loading" | "idle" | "error">("loading");
  useEffect(() => {
    void (async () => {
      const token = await getToken();
      if (!token) return;
      const r = await apiGet<Worker>("/workers/me", token);
      if (r.ok) setW(r.data);
      setState(r.ok ? "idle" : "error");
    })();
  }, [getToken]);
  if (state === "loading") return <p role="status">Memuat…</p>;
  if (!w) return <p role="alert">Data pekerja tidak dapat dimuat.</p>;
  return (
    <dl className="facts">
      <dt>SHO ID</dt>
      <dd>{w.sho_id}</dd>
      <dt>Nomor pekerja</dt>
      <dd>{w.employee_number}</dd>
      <dt>Posisi</dt>
      <dd>{w.job_position?.name ?? "-"}</dd>
      <dt>Site</dt>
      <dd>{w.site?.name ?? "-"}</dd>
      <dt>Department</dt>
      <dd>{w.department?.name ?? "-"}</dd>
      <dt>Status kerja</dt>
      <dd>{EMPLOYMENT_LABEL[w.employment_status]}</dd>
      <dt>Status</dt>
      <dd>{WORKER_STATUS_LABEL[w.worker_status]}</dd>
      <dt>Tanggal masuk</dt>
      <dd>{w.join_date}</dd>
    </dl>
  );
}

export function AccountView() {
  const { me, email } = useMe();
  return (
    <>
      <section className="card" aria-labelledby="profil">
        <h2 id="profil">Profil</h2>
        <dl className="facts">
          <dt>Nama</dt>
          <dd>{me.full_name ?? "-"}</dd>
          <dt>Email</dt>
          <dd>{email ?? "-"}</dd>
          <dt>Perusahaan</dt>
          <dd>{me.organization ? `${me.organization.name}${me.organization.code ? ` (${me.organization.code})` : ""}` : "-"}</dd>
          <dt>Terhubung ke data pekerja</dt>
          <dd>{me.worker_id ? "Ya" : "Tidak"}</dd>
        </dl>
      </section>
      {me.worker_id ? (
        <section className="card" aria-labelledby="pekerja">
          <h2 id="pekerja">Data pekerja saya</h2>
          <MyWorker />
          <p className="muted small-text">Perubahan data hubungi admin perusahaan.</p>
        </section>
      ) : null}
      {me.worker_id && (me.self_permissions ?? []).includes("readiness.read") ? (
        <>
          <ReadinessSection workerId={me.worker_id} canEvaluate={false} />
          <PassportCard workerId={me.worker_id} />
        </>
      ) : null}
      {me.worker_id && (me.self_permissions ?? []).includes("competency.read") ? (
        <CompetencySection
          workerId={me.worker_id}
          title="Kompetensi saya"
          canEdit={(me.self_permissions ?? []).includes("competency.update")}
          canVerify={false}
        />
      ) : null}
      {me.worker_id && (me.self_permissions ?? []).includes("authorization.read") ? (
        <AuthorizationSection
          workerId={me.worker_id}
          title="Otorisasi Kerja saya"
          canEdit={(me.self_permissions ?? []).includes("authorization.update")}
          canVerify={false}
        />
      ) : null}
      {me.worker_id && (me.self_permissions ?? []).includes("simper.read") ? (
        <SimperSection
          workerId={me.worker_id}
          title="SIMPER saya"
          canEdit={(me.self_permissions ?? []).includes("simper.update")}
          canVerify={false}
        />
      ) : null}
      {me.worker_id && (me.self_permissions ?? []).includes("medical.read_status") ? (
        <MedicalSection
          workerId={me.worker_id}
          title="Medical saya"
          canStatus
          canRecord={false}
          canDetail={(me.self_permissions ?? []).includes("medical.read_detail")}
          canDetermine={false}
          self
        />
      ) : null}
      <section className="card" aria-labelledby="peran">
        <h2 id="peran">Peran</h2>
        <ul>
          {me.role_assignments.map((r) => (
            <li key={r.id}>
              {ROLE_LABEL[r.role_code] ?? r.role_code} · {SCOPE_LABEL[r.scope_type] ?? r.scope_type}
            </li>
          ))}
        </ul>
        <p className="muted">{me.permissions.length} izin aktif. Menu menyesuaikan peran ini.</p>
      </section>
    </>
  );
}

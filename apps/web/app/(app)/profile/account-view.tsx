"use client";

import { ROLE_LABEL, SCOPE_LABEL } from "@/lib/nav";
import { useMe } from "@/lib/session";

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

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { type AuditEvent, apiGet, type DashboardSummary, fetchAuditPage } from "@/lib/api";
import { ACTION_LABEL, ROLE_LABEL, SCOPE_LABEL } from "@/lib/nav";
import { useMe, useSession } from "@/lib/session";
import { formatTime } from "../time";

/**
 * Beranda sesuai peran (PB-020, UIUX-002 §5). Fase P0:
 * - Company Admin (user.manage): Dashboard Administrasi (pengguna, undangan, kelengkapan data pekerja).
 * - Pemegang audit.view: aktivitas terbaru dari Jejak Audit.
 * - Peran lain: panel peran; dashboard operasional dan pribadi tersedia di P1.
 * Dashboard hanya membaca dan tidak menghitung status kesiapan.
 */
export function DashboardView() {
  const { me } = useMe();
  const { getToken } = useSession();
  const has = (p: string) => me.permissions.includes(p);
  const [summary, setSummary] = useState<DashboardSummary | null | "error">(null);
  const [recent, setRecent] = useState<AuditEvent[] | null | "error">(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const token = await getToken();
      if (!token) return;
      if (me.permissions.includes("dashboard.view")) {
        const r = await apiGet<DashboardSummary>("/dashboard/summary", token);
        if (active) setSummary(r.ok ? r.data : "error");
      }
      if (me.permissions.includes("audit.view")) {
        const to = new Date();
        const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
        const r = await fetchAuditPage(token, { from: from.toISOString(), to: to.toISOString(), limit: 5 });
        if (active) setRecent(r.ok ? r.data : "error");
      }
    })();
    return () => {
      active = false;
    };
  }, [getToken, me.permissions]);

  const firstName = me.full_name?.split(" ")[0] ?? "";
  const admin = summary && summary !== "error" ? summary.administration : undefined;

  return (
    <>
      <p className="eyebrow">{me.organization?.name ?? "Safety On Hand"}</p>
      <h1>Selamat datang{firstName ? `, ${firstName}` : ""}</h1>
      <p className="muted">
        {me.role_assignments
          .map((r) => `${ROLE_LABEL[r.role_code] ?? r.role_code} (${SCOPE_LABEL[r.scope_type] ?? r.scope_type})`)
          .join(" · ") || "Belum ada peran aktif"}
      </p>

      {has("user.manage") ? (
        <section className="card" aria-labelledby="adm">
          <h2 id="adm">Administrasi perusahaan</h2>
          {summary === "error" ? (
            <p role="alert">Ringkasan tidak dapat dimuat.</p>
          ) : !admin ? (
            <p role="status">Memuat…</p>
          ) : (
            <>
              <div className="kpis">
                <Kpi label="Pengguna aktif" value={admin.users.active} />
                <Kpi label="Undangan tertunda" value={admin.users.invited} />
                <Kpi label="Pengguna dikunci / nonaktif" value={admin.users.locked + admin.users.deactivated} />
                <Kpi label="Pekerja" value={admin.workers.total} />
                <Kpi label="Pekerja dengan akun" value={admin.workers.with_account} />
                <Kpi
                  label="Pekerja tanpa Job Position"
                  value={admin.workers.missing_job_position}
                  tone={admin.workers.missing_job_position > 0 ? "warning" : undefined}
                />
              </div>
              {summary ? <p className="muted small-text">Data per {formatTime(summary.as_of)}</p> : null}
            </>
          )}
        </section>
      ) : null}

      {has("audit.view") ? (
        <section className="card" aria-labelledby="akt">
          <h2 id="akt">Aktivitas terbaru (7 hari)</h2>
          {recent === "error" ? (
            <p role="alert">Aktivitas tidak dapat dimuat.</p>
          ) : recent === null ? (
            <p role="status">Memuat…</p>
          ) : recent.length === 0 ? (
            <p className="muted">Belum ada aktivitas tercatat.</p>
          ) : (
            <ul className="activity">
              {recent.map((e) => (
                <li key={e.id}>
                  <span>{ACTION_LABEL[e.action] ?? e.action}</span>
                  <span className="muted">
                    {e.actor?.full_name ?? (e.actor_kind === "SYSTEM" ? "Sistem" : "-")} · {formatTime(e.occurred_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p>
            <Link href="/audit">Buka Jejak Audit</Link>
          </p>
        </section>
      ) : null}

      {!has("user.manage") && !has("audit.view") ? (
        <section className="card">
          <h2>Ringkasan</h2>
          <p className="muted">
            {me.worker_id
              ? "Dashboard pribadi (status kesiapan, syarat, dan Safety Passport) tersedia setelah modul Kesiapan dirilis (P1)."
              : "Dashboard operasional (kesiapan tim, syarat yang akan berakhir, antrean verifikasi) tersedia setelah modul Kesiapan dirilis (P1)."}
          </p>
        </section>
      ) : null}
    </>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number; tone?: "warning" }) {
  return (
    <div className={`kpi${tone ? ` kpi-${tone}` : ""}`}>
      <span className="kpi-value">{value.toLocaleString("id-ID")}</span>
      <span className="kpi-label">{label}</span>
    </div>
  );
}

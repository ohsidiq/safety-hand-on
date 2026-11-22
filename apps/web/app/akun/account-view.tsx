"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchMe, type Me, type MeResult } from "@/lib/api";
import { getSupabase } from "@/lib/supabase";

const FAIL_TEXT: Record<Exclude<MeResult, { ok: true }>["code"], string> = {
  UNAUTHORIZED: "Akun ini belum terdaftar di Safety On Hand. Hubungi administrator perusahaan Anda.",
  TOKEN_EXPIRED: "Sesi berakhir. Silakan masuk kembali.",
  ACCOUNT_DEACTIVATED: "Akun Anda dinonaktifkan. Hubungi administrator perusahaan Anda.",
  ACCOUNT_LOCKED: "Akun Anda dikunci sementara. Coba lagi nanti.",
  UNAVAILABLE: "Layanan sedang tidak dapat dijangkau. Coba lagi beberapa saat lagi.",
};

const SCOPE_TEXT: Record<string, string> = {
  PLATFORM: "Platform",
  ORGANIZATION: "Seluruh perusahaan",
  SITE: "Site",
  DEPARTMENT: "Department",
  TEAM: "Tim",
  CONTRACTOR: "Kontraktor",
  SELF: "Diri sendiri",
};

export function AccountView() {
  const router = useRouter();
  const supabase = getSupabase();
  const [state, setState] = useState<{ loading: true } | { loading: false; result: MeResult; email: string | null }>({
    loading: true,
  });

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session) {
        router.replace("/masuk");
        return;
      }
      const result = await fetchMe(data.session.access_token);
      if (active) setState({ loading: false, result, email: data.session.user.email ?? null });
    });
    return () => {
      active = false;
    };
  }, [supabase, router]);

  async function signOut() {
    await supabase?.auth.signOut();
    router.replace("/masuk");
  }

  if (!supabase) return <p role="alert">Login belum dikonfigurasi di lingkungan ini.</p>;
  if (state.loading) return <p role="status">Memuat…</p>;

  const { result, email } = state;
  return (
    <>
      {result.ok ? (
        <Profile me={result.me} email={email} />
      ) : (
        <section className="card">
          <p role="alert">{FAIL_TEXT[result.code]}</p>
        </section>
      )}
      <p>
        <button type="button" className="secondary" onClick={signOut}>
          Keluar
        </button>
      </p>
    </>
  );
}

function Profile({ me, email }: { me: Me; email: string | null }) {
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
              {r.role_code} · {SCOPE_TEXT[r.scope_type] ?? r.scope_type}
            </li>
          ))}
        </ul>
        <p className="muted">{me.permissions.length} izin aktif. Menu akan menyesuaikan peran ini.</p>
      </section>
    </>
  );
}

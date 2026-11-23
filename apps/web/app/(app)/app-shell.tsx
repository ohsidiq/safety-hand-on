"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { apiGet, NOTIFICATIONS_CHANGED } from "@/lib/api";
import { visibleNav } from "@/lib/nav";
import { useSession } from "@/lib/session";

const FAIL_TEXT: Record<string, string> = {
  UNAUTHORIZED: "Akun ini belum terdaftar di Safety On Hand. Hubungi administrator perusahaan Anda.",
  TOKEN_EXPIRED: "Sesi berakhir. Silakan masuk kembali.",
  ACCOUNT_DEACTIVATED: "Akun Anda dinonaktifkan. Hubungi administrator perusahaan Anda.",
  ACCOUNT_LOCKED: "Akun Anda dikunci sementara. Coba lagi nanti.",
  UNAVAILABLE: "Layanan sedang tidak dapat dijangkau. Coba lagi beberapa saat lagi.",
  NOT_CONFIGURED: "Login belum dikonfigurasi di lingkungan ini.",
};

/** Kerangka aplikasi (UIUX-002 §3 dan §7): header, menu samping di layar lebar, navigasi bawah di ponsel. */
export function AppShell({ children }: { children: ReactNode }) {
  const { state, signOut, getToken } = useSession();
  const pathname = usePathname();
  const [unread, setUnread] = useState<number | null>(null);
  const canNotify = state.status === "ready" && state.me.permissions.includes("notification.read");

  // Lencana belum dibaca (API-015): dimuat saat halaman berganti, tiap 60 detik, dan setelah notifikasi dibaca
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname sengaja dipakai sebagai pemicu muat ulang saat pindah halaman
  useEffect(() => {
    if (!canNotify) return;
    let active = true;
    const refresh = async () => {
      const token = await getToken();
      if (!token) return;
      const r = await apiGet<{ unread: number }>("/notifications/unread-count", token);
      if (active && r.ok) setUnread(r.data.unread);
    };
    void refresh();
    const timer = setInterval(refresh, 60_000);
    window.addEventListener(NOTIFICATIONS_CHANGED, refresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener(NOTIFICATIONS_CHANGED, refresh);
    };
  }, [canNotify, getToken, pathname]);

  if (state.status === "loading") {
    return (
      <main className="shell">
        <p role="status">Memuat…</p>
      </main>
    );
  }
  if (state.status === "error") {
    return (
      <main className="shell">
        <p className="eyebrow">Safety On Hand</p>
        <section className="card">
          <p role="alert">{FAIL_TEXT[state.code] ?? FAIL_TEXT.UNAVAILABLE}</p>
        </section>
        <p>
          <button type="button" className="secondary" onClick={signOut}>
            Keluar
          </button>
        </p>
      </main>
    );
  }

  const items = visibleNav(state.me.permissions);
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="app">
      <header className="app-header">
        <Link href="/dashboard" className="brand">
          Safety On Hand
        </Link>
        <span className="org muted">{state.me.organization?.name ?? ""}</span>
        {canNotify ? (
          <Link href="/notifications" className="bell" aria-label={unread ? `Notifikasi, ${unread} belum dibaca` : "Notifikasi"}>
            <span aria-hidden="true">🔔</span>
            {unread ? <span className="bell-count">{unread > 99 ? "99+" : unread}</span> : null}
          </Link>
        ) : null}
        <button type="button" className="secondary small" onClick={signOut}>
          Keluar
        </button>
      </header>
      <nav className="side-nav" aria-label="Menu utama">
        <ul>
          {items.map((i) => (
            <li key={i.href}>
              <Link href={i.href} aria-current={isActive(i.href) ? "page" : undefined}>
                {i.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <main className="app-main">{children}</main>
      <nav className="bottom-nav" aria-label="Navigasi bawah">
        {items.slice(0, 5).map((i) => (
          <Link key={i.href} href={i.href} aria-current={isActive(i.href) ? "page" : undefined}>
            {i.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

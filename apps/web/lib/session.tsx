"use client";

import { useRouter } from "next/navigation";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { fetchMe, type Me, type MeResult } from "./api";
import { rememberReturnTo } from "./return-to";
import { getSupabase } from "./supabase";

/**
 * Sesi pengguna di web: token akses Supabase (hanya untuk login, ARCH-001) dan identitas dari GET /auth/me.
 * Peran dan permission selalu dari Core API, tidak dari token (AUTH-API-007).
 */
type FailCode = Exclude<MeResult, { ok: true }>["code"];

export type SessionState =
  | { status: "loading" }
  | { status: "ready"; me: Me; email: string | null; token: string }
  | { status: "error"; code: FailCode | "NOT_CONFIGURED" };

interface SessionValue {
  state: SessionState;
  /** Token akses terbaru (diperbarui otomatis oleh Supabase). */
  getToken: () => Promise<string | null>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const supabase = getSupabase();
  const [state, setState] = useState<SessionState>(
    supabase ? { status: "loading" } : { status: "error", code: "NOT_CONFIGURED" },
  );

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session) {
        rememberReturnTo(window.sessionStorage, window.location.pathname + window.location.hash);
        router.replace("/login");
        return;
      }
      const r = await fetchMe(data.session.access_token);
      if (!active) return;
      setState(
        r.ok
          ? { status: "ready", me: r.me, email: data.session.user.email ?? null, token: data.session.access_token }
          : { status: "error", code: r.code },
      );
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") router.replace("/login");
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [supabase, router]);

  const getToken = useCallback(async () => {
    const { data } = (await supabase?.auth.getSession()) ?? { data: { session: null } };
    return data.session?.access_token ?? null;
  }, [supabase]);

  const signOut = useCallback(async () => {
    await supabase?.auth.signOut();
    router.replace("/login");
  }, [supabase, router]);

  return <SessionContext.Provider value={{ state, getToken, signOut }}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error("useSession harus di dalam SessionProvider");
  return v;
}

/** Identitas yang sudah siap; komponen di dalam AppShell hanya dirender saat status ready. */
export function useMe(): { me: Me; email: string | null } {
  const { state } = useSession();
  if (state.status !== "ready") throw new Error("Sesi belum siap");
  return { me: state.me, email: state.email };
}

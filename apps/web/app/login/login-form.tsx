"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { getSupabase, loginErrorMessage } from "@/lib/supabase";

export function LoginForm() {
  const router = useRouter();
  const supabase = getSupabase();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase?.auth.getSession().then(({ data }) => {
      if (data.session) router.replace("/dashboard");
    });
  }, [supabase, router]);

  if (!supabase) {
    return (
      <section className="card">
        <p role="alert">Login belum dikonfigurasi di lingkungan ini.</p>
      </section>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setError("");
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (err) {
      setError(loginErrorMessage(err));
      return;
    }
    router.replace("/dashboard");
  }

  async function onGoogle() {
    if (!supabase) return;
    setError("");
    const { error: err } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/dashboard` },
    });
    if (err) setError("Masuk dengan Google belum tersedia.");
  }

  return (
    <section className="card">
      <form onSubmit={onSubmit} className="form" noValidate>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <label htmlFor="password">Kata sandi</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
        <button type="submit" disabled={busy || !email || !password}>
          {busy ? "Memproses…" : "Masuk"}
        </button>
      </form>
      <p className="divider muted">atau</p>
      <button type="button" className="secondary" onClick={onGoogle}>
        Masuk dengan Google
      </button>
    </section>
  );
}

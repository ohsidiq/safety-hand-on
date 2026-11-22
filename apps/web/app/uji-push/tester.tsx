"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/api";
import { detectPushEnvironment, type PushEnvironment, urlBase64ToUint8Array } from "@/lib/push";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

export function PushTester() {
  const [env, setEnv] = useState<PushEnvironment | null>(null);
  const [sub, setSub] = useState<PushSubscription | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const add = (line: string) => setLog((l) => [`${new Date().toLocaleTimeString("id-ID")}  ${line}`, ...l]);

  useEffect(() => {
    setEnv(detectPushEnvironment(navigator, window));
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then((reg) => reg.pushManager?.getSubscription())
        .then((s) => s && setSub(s))
        .catch(() => undefined);
    }
  }, []);

  async function enable() {
    setBusy(true);
    try {
      if (!VAPID_PUBLIC_KEY) throw new Error("Kunci publik VAPID belum diatur di server web");
      const permission = await Notification.requestPermission();
      setEnv((e) => (e ? { ...e, permission } : e));
      if (permission !== "granted") throw new Error(`Izin notifikasi: ${permission}`);
      const reg = await navigator.serviceWorker.ready;
      const s =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        }));
      setSub(s);
      add(`Langganan aktif (${new URL(s.endpoint).hostname})`);
    } catch (e) {
      add(`Gagal mengaktifkan: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    if (!sub) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/spike/push-test"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      add(res.status === 202 ? "Terkirim ke layanan push. Tunggu notifikasi muncul." : `Server menjawab ${res.status}`);
    } catch (e) {
      add(`Gagal mengirim: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  if (!env) return <p className="muted">Memeriksa perangkat…</p>;

  const needsInstall = env.isIOS && !env.standalone;

  return (
    <>
      <section className="card" aria-labelledby="env-heading">
        <h2 id="env-heading">Perangkat ini</h2>
        <ul className="facts">
          <li>Dukungan push: {env.supported ? "ya" : "tidak"}</li>
          <li>iPhone/iPad: {env.isIOS ? "ya" : "tidak"}</li>
          <li>Dibuka dari Home Screen: {env.standalone ? "ya" : "tidak"}</li>
          <li>Izin notifikasi: {env.permission}</li>
        </ul>
        {needsInstall && (
          <p className="notice">
            Di iPhone, notifikasi hanya bisa dari aplikasi yang dipasang: ketuk <strong>Share</strong> →{" "}
            <strong>Add to Home Screen</strong>, lalu buka Safety On Hand dari Home Screen dan kembali ke halaman ini.
          </p>
        )}
      </section>

      <section className="card" aria-labelledby="act-heading">
        <h2 id="act-heading">Langkah</h2>
        <div className="actions">
          <button type="button" onClick={enable} disabled={busy || needsInstall || !env.supported}>
            1. Izinkan notifikasi
          </button>
          <button type="button" onClick={sendTest} disabled={busy || !sub}>
            2. Kirim uji
          </button>
        </div>
        <ol className="log" aria-live="polite">
          {log.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ol>
      </section>
    </>
  );
}

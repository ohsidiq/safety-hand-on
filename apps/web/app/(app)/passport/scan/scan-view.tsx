"use client";

import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { apiGet } from "@/lib/api";
import { canSee } from "@/lib/nav";
import { type PassportVerification, parseScanned, passportErrorMessage, WARNING_LABEL } from "@/lib/passport";
import { ITEM_TYPE_LABEL, STATUS_BADGE, STATUS_LABEL } from "@/lib/readiness";
import { useMe, useSession } from "@/lib/session";
import { formatTime } from "../../time";

// BarcodeDetector belum ada di lib.dom TypeScript; dipakai bila peramban mendukung (Chrome Android).
type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };
type DetectorCtor = new (opts: { formats: string[] }) => Detector;

/**
 * Pemindai QR Safety Passport (API-014 bagian 7). Token dibaca dari kamera (BarcodeDetector) atau dari tautan yang dibuka
 * kamera bawaan ponsel (#t=...), atau ditempel manual. Verifikasi di server: pemindai harus berwenang atas pekerja itu.
 */
export function ScanView() {
  const { me } = useMe();
  const { getToken } = useSession();
  const id = useId();
  const allowed = canSee(me.permissions, "/passport/scan");
  const [result, setResult] = useState<PassportVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState("");
  const [camera, setCamera] = useState<"off" | "on" | "unsupported">("off");
  const video = useRef<HTMLVideoElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const loop = useRef<number | null>(null);

  const verify = useCallback(
    async (raw: string) => {
      const token = parseScanned(raw);
      if (!token) {
        setResult(null);
        setError("QR tidak dikenali. Pastikan yang dipindai adalah QR Safety Passport.");
        return;
      }
      const auth = await getToken();
      if (!auth) return;
      setBusy(true);
      const r = await apiGet<PassportVerification>("/passport/verify", auth, fetch, { "X-Passport-Token": token });
      setBusy(false);
      if (r.ok) {
        setError(null);
        setResult(r.data);
      } else {
        setResult(null);
        setError(passportErrorMessage(r));
      }
    },
    [getToken],
  );

  const stopCamera = useCallback(() => {
    if (loop.current) cancelAnimationFrame(loop.current);
    loop.current = null;
    for (const t of stream.current?.getTracks() ?? []) t.stop();
    stream.current = null;
    setCamera((c) => (c === "on" ? "off" : c));
  }, []);

  // tautan dari kamera bawaan ponsel: token di fragmen, langsung diverifikasi lalu fragmen dihapus dari riwayat
  useEffect(() => {
    if (!allowed) return;
    const hash = window.location.hash;
    if (hash.includes("t=")) {
      window.history.replaceState(null, "", window.location.pathname);
      void verify(hash);
    }
    return stopCamera;
  }, [allowed, verify, stopCamera]);

  async function startCamera() {
    const Ctor = (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
    if (!Ctor || !navigator.mediaDevices?.getUserMedia) {
      setCamera("unsupported");
      return;
    }
    try {
      const detector = new Ctor({ formats: ["qr_code"] });
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      stream.current = s;
      setCamera("on");
      const el = video.current;
      if (!el) return;
      el.srcObject = s;
      await el.play();
      const scan = async () => {
        if (!stream.current) return;
        try {
          const found = await detector.detect(el);
          const value = found[0]?.rawValue;
          if (value) {
            stopCamera();
            await verify(value);
            return;
          }
        } catch {
          // bingkai belum siap; coba lagi
        }
        loop.current = requestAnimationFrame(() => void scan());
      };
      void scan();
    } catch {
      setError("Kamera tidak dapat dibuka. Izinkan akses kamera atau tempel isi QR secara manual.");
      stopCamera();
    }
  }

  function submitManual(e: FormEvent) {
    e.preventDefault();
    void verify(manual);
  }

  if (!allowed) return <p role="alert">Anda tidak berwenang memindai QR.</p>;

  return (
    <>
      <section className="card panel" aria-labelledby="pindai">
        <h2 id="pindai">Pindai</h2>
        <video ref={video} className="scan-video" playsInline muted hidden={camera !== "on"} />
        {camera === "on" ? (
          <button type="button" className="secondary small" onClick={stopCamera}>
            Matikan kamera
          </button>
        ) : (
          <button type="button" onClick={() => void startCamera()}>
            Buka kamera
          </button>
        )}
        {camera === "unsupported" ? (
          <p className="muted small-text">
            Peramban ini belum mendukung pemindaian di halaman. Pakai kamera bawaan ponsel untuk memindai QR (tautan akan membuka
            halaman ini), atau tempel isi QR di bawah.
          </p>
        ) : null}
        <form className="form" onSubmit={submitManual}>
          <label htmlFor={`${id}-m`}>
            Isi QR (manual)
            <input id={`${id}-m`} value={manual} onChange={(e) => setManual(e.target.value)} autoComplete="off" />
          </label>
          <button type="submit" className="secondary" disabled={busy || !manual.trim()}>
            Periksa
          </button>
        </form>
      </section>
      {busy ? <p role="status">Memeriksa…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {result ? <ResultCard r={result} /> : null}
    </>
  );
}

function ResultCard({ r }: { r: PassportVerification }) {
  return (
    <section className="card panel" aria-labelledby="hasil-pindai" aria-live="polite">
      <h2 id="hasil-pindai">{r.full_name}</h2>
      <p className="muted">
        {r.job_position ?? "Jabatan belum diisi"} · {r.site ?? "-"}
      </p>
      {r.status ? (
        <p>
          <span className={`badge badge-large ${STATUS_BADGE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
        </p>
      ) : (
        <p>Belum dinilai.</p>
      )}
      {r.categories.length > 0 ? (
        <ul className="stack">
          {r.categories.map((c) => (
            <li key={c.item_type}>
              <span className={`badge ${c.ok ? (c.warning ? "badge-warning" : "badge-success") : "badge-denied"}`}>
                {c.ok ? "Terpenuhi" : "Belum terpenuhi"}
              </span>{" "}
              {ITEM_TYPE_LABEL[c.item_type]}
              {c.ok && c.warning ? <span className="muted small-text"> ({WARNING_LABEL[c.warning]})</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {r.evaluated_at ? <p className="muted small-text">Dinilai {formatTime(r.evaluated_at)}</p> : null}
    </section>
  );
}

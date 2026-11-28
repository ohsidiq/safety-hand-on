"use client";

import QRCode from "qrcode";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiSend } from "@/lib/api";
import { type PassportToken, passportErrorMessage, passportUrl, secondsLeft } from "@/lib/passport";
import { useSession } from "@/lib/session";

/**
 * QR Safety Passport milik pekerja (FR-RE-013). QR berisi token 5 menit (bukan SHO ID) dan diperbarui otomatis, sehingga
 * tangkapan layar lama tidak berlaku. Pemindai harus masuk ke aplikasi dan berwenang atas pekerja ini.
 */
export function PassportCard({ workerId }: { workerId: string }) {
  const { getToken } = useSession();
  const [qr, setQr] = useState<string | null>(null);
  const [token, setToken] = useState<PassportToken | null>(null);
  const [left, setLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const auth = await getToken();
    if (!auth) return;
    const r = await apiSend<PassportToken>("POST", `/workers/${workerId}/passport/token`, auth);
    if (!r.ok) {
      setError(passportErrorMessage(r.error));
      setQr(null);
      return;
    }
    setError(null);
    setToken(r.data);
    setQr(
      await QRCode.toDataURL(passportUrl(window.location.origin, r.data.token), {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 280,
      }),
    );
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void refresh(), r.data.refresh_after_seconds * 1000);
  }, [getToken, workerId]);

  useEffect(() => {
    if (!shown) return;
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [shown, refresh]);

  useEffect(() => {
    if (!token) return;
    const tick = () => setLeft(secondsLeft(token.expires_at));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [token]);

  return (
    <section className="card" aria-labelledby="passport">
      <h2 id="passport">QR Safety Passport</h2>
      <p className="muted small-text">
        Tunjukkan QR ini kepada petugas di lapangan. QR berganti otomatis dan hanya berlaku beberapa menit, jadi tangkapan layar
        tidak dapat dipakai.
      </p>
      {!shown ? (
        <button type="button" onClick={() => setShown(true)}>
          Tampilkan QR
        </button>
      ) : (
        <>
          {error ? <p role="alert">{error}</p> : null}
          {qr ? (
            <figure className="passport-qr">
              {/* biome-ignore lint/performance/noImgElement: data URL QR yang dibuat di perangkat */}
              <img src={qr} alt="QR Safety Passport" width={280} height={280} />
              <figcaption className="muted small-text" aria-live="polite">
                {left > 0 ? `Berlaku ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} lagi` : "Memperbarui…"}
              </figcaption>
            </figure>
          ) : error ? null : (
            <p role="status">Membuat QR…</p>
          )}
          <span className="row-actions">
            <button type="button" className="secondary small" onClick={() => void refresh()}>
              Perbarui QR
            </button>
            <button type="button" className="secondary small" onClick={() => setShown(false)}>
              Sembunyikan
            </button>
          </span>
        </>
      )}
    </section>
  );
}

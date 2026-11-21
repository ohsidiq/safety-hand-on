"use client";

import { useEffect } from "react";

/** Mendaftarkan service worker PWA. Hanya di produksi agar tidak mengganggu pengembangan. */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // Kegagalan pendaftaran tidak menghalangi aplikasi
    });
  }, []);
  return null;
}

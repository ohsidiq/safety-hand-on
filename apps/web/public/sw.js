/* Service worker Safety On Hand (M0, minimal).
 * Strategi: halaman offline untuk navigasi saat jaringan putus. Data bisnis TIDAK di-cache di sini:
 * respons API dapat memuat data pribadi dan harus mengikuti aturan cache tersendiri (offline dasar = P2).
 */
const CACHE = "soh-shell-v2";
const OFFLINE_URL = "/offline";
const PRECACHE = [OFFLINE_URL, "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.mode !== "navigate") return; // hanya navigasi halaman
  event.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL)));
});

// Web Push (spike S-6, PLT02 di M1). Isi notifikasi tidak boleh memuat data sensitif (B-24, PB-019).
self.addEventListener("push", (event) => {
  let data = { title: "Safety On Hand", body: "Ada pemberitahuan baru.", url: "/" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    // isi bukan JSON: pakai teks bawaan
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: data.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url === url && "focus" in c) return c.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});

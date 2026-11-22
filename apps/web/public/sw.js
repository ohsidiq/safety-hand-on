/* Service worker Safety On Hand (M0, minimal).
 * Strategi: halaman offline untuk navigasi saat jaringan putus. Data bisnis TIDAK di-cache di sini:
 * respons API dapat memuat data pribadi dan harus mengikuti aturan cache tersendiri (offline dasar = P2).
 */
const CACHE = "soh-shell-v1";
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

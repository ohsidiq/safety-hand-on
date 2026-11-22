# apps/web

Klien Web/PWA (Next.js, dihosting di Vercel). Manifest, service worker (halaman offline saja, data bisnis tidak
di-cache), tema netral sampai tema perusahaan ditetapkan. Klien tidak membaca tabel database langsung (ARCH-001):
semua lewat Core API (`NEXT_PUBLIC_API_BASE_URL`).

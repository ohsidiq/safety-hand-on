# Kebijakan Keamanan

Safety On Hand adalah proyek portofolio. Semua data di repositori dan lingkungan staging adalah **data sintetis**;
tidak ada data pekerja nyata, NIK, atau data medis nyata (keputusan B-24).

## Melaporkan celah keamanan

Jangan membuka issue publik untuk celah keamanan. Laporkan secara privat lewat
**Security → Report a vulnerability** di repositori ini (GitHub private vulnerability reporting).
Sertakan langkah reproduksi, dampak yang diperkirakan, dan versi atau commit yang terdampak.
Kami berusaha menanggapi dalam 7 hari.

## Praktik yang diterapkan

- Rahasia (kredensial database, kunci VAPID privat, token) hanya disimpan di pengelola rahasia penyedia (Vercel,
  Supabase, GitHub Secrets), tidak pernah di repositori. `.env.example` hanya memuat nama variabel.
- CI memindai seluruh riwayat git dengan Gitleaks; GitHub secret scanning, push protection, CodeQL, dan Dependabot aktif.
- Isolasi tenant dengan Row Level Security PostgreSQL pada semua tabel bisnis, diuji otomatis (S-4).
- Klien tidak mengakses tabel database langsung; semua operasi lewat Core API (ARCH-001).
- Log tidak memuat token, kredensial, NIK, atau data medis.

## Cakupan

Kode di repositori ini serta deployment staging `soh-web.vercel.app` dan `soh-api.vercel.app`.
Pengujian yang merusak, membebani layanan, atau mencoba mengakses data pihak lain tidak diizinkan.

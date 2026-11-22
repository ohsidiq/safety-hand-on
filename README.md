# Safety On Hand

Proyek portofolio: platform kesiapan kerja (Workforce Readiness) dan kepatuhan keselamatan untuk operasi 24 jam. Pertanyaan inti: **"Siapkah pekerja ini bekerja hari ini?"**

> Nama lama "Safety Hand On" sudah tidak dipakai. Nama resmi: **Safety On Hand**. Data hanya sintetis (B-24).

## Status

Milestone **M0 (fondasi) TESTED** (2026-11-22). Staging publik: https://soh-web.vercel.app dan https://soh-api.vercel.app. M1 berikutnya.

| Bagian | Isi | Status |
|---|---|---|
| `db/` | Migrasi terversi, seed sintetis, uji RLS (46 pemeriksaan), spike S-1..S-4 | Diuji lokal dan di CI |
| `apps/api` | Core API (Hono + OpenAPI 3.1), `/api/v1/health/live`, `/api/v1/health/ready` | Kerangka, diuji |
| `apps/worker` | Pemroses outbox (`SKIP LOCKED`, savepoint per event, antrean gagal) | Kerangka, diuji |
| `apps/web` | PWA Next.js (manifest, service worker, halaman offline), tema netral | Kerangka, diuji |
| `packages/db` | `withUser` (RLS per transaksi) dan `withWorker` | Diuji |
| `openapi/v1.yaml` | Kontrak API, dibangkitkan dari kode dan dicek di CI | Sinkron |

Belum ada: autentikasi, fitur bisnis, staging, spike S-6 (push iOS PWA).

## Arsitektur (ADR-001 Opsi B)

```text
Web/PWA (Vercel) ──HTTPS──► Core API ──► Supabase Auth, PostgreSQL + RLS, Storage privat
                                 │
                                 └─ outbox_event ──► Worker (notifikasi, audit, evaluasi readiness)
```

- Klien tidak membaca atau menulis tabel langsung (ARCH-001).
- Setiap kueri bisnis lewat `withUser`: `SET LOCAL ROLE app_authenticated` + `app.user_id`, jadi RLS selalu berlaku (ARCH-002).
- Efek samping lewat outbox transaksional, worker idempoten (ARCH-005, ARCH-006).

## Menjalankan lokal

Butuh Node 22+, pnpm 10, PostgreSQL 15+.

```bash
pnpm install
cp .env.example .env.local          # isi DATABASE_URL

# database uji dari nol: migrasi dua kali, seed, uji RLS (MENGHAPUS database m0test)
PGHOST=localhost PGUSER=postgres bash scripts/test-db.sh

pnpm dev:api      # http://localhost:8787/api/v1/health/live
pnpm dev:web      # http://localhost:3000
pnpm dev:worker

pnpm lint && pnpm typecheck && pnpm test
DATABASE_URL=postgres://postgres@localhost:5432/m0test pnpm test   # termasuk uji integrasi
pnpm --filter @soh/api openapi      # perbarui openapi/v1.yaml setelah mengubah rute
```

## Gerbang CI (`.github/workflows/ci.yml`)

Lint dan format (Biome), pemeriksaan tipe, kontrak OpenAPI sinkron, uji unit, build web, audit dependensi, migrasi dari nol dua kali, uji isolasi tenant, uji integrasi API dan worker terhadap PostgreSQL 16, pemindaian rahasia (Gitleaks).

## Dokumentasi

Sumber kebenaran ada di vault Obsidian (`docs/`). Urutan otoritas: **Decision Baseline (B-01..B-26) → SRS → PRD**.

# Database

- `migrations/`: SQL terversi dan berurutan. Diterapkan oleh `scripts/migrate.sh`, sekali per berkas, dapat
  diulang dari nol. Skema tidak boleh berubah lewat dasbor penyedia (ARCH-008).
- `seed/synthetic_seed.sql`: data sintetis deterministik (B-24). Tidak ada data nyata.
- `tests/`: uji database. `scripts/test-db.sh` membuat database dari nol, migrasi dua kali (harus idempoten),
  memuat seed kecil, lalu menjalankan semua berkas di sini.
- `spikes/`: spike ADR-001 beserta hasilnya di `spikes/RESULTS.md`.

Status migrasi: `0001` dan `0002` adalah subset minimal M0 untuk membuktikan pola. DB-000..DB-008 menggantikan
dan memperluasnya di M1 dan M2. Peran dan izin di `0002` bukan PB-009.

## Aturan kebijakan RLS
1. Setiap tabel ber-`organization_id` wajib `enable` dan `force row level security` serta punya kebijakan (diuji T1).
2. Nilai konstan di kebijakan ditulis sebagai `(select fungsi(...))` supaya dihitung sekali per kueri.
   Jangan memanggil fungsi izin dengan argumen kolom per baris (20 sampai 30 kali lebih lambat pada S-1).
3. Detail data Sensitif hanya lewat izin tingkat organisasi, tanpa jalur per Site.
4. Tabel anak membawa `site_id` dan memakai FK komposit `(worker_id, organization_id, site_id)`.

`0003_runtime_roles.sql`: peran `app_worker` (hanya outbox) dan kolom percobaan ulang/antrean gagal pada outbox.

`0004_hardening.sql`: hasil Supabase Security Advisor pada staging. RLS pada tabel acuan peran/izin, `search_path`
dikunci, hak peran klien Supabase (`anon`, `authenticated`) dicabut dari tabel aplikasi (ARCH-001), dan
`schema_migrations` dilindungi RLS.

`0005_identity_access.sql` (M1.1): katalog resmi 12 role (PB-008), 56 permission dan 240 pemetaan dengan level
`FULL`/`LIMITED`/`TEAM`/`SELF` (PB-009), dibangkitkan dari `packages/rbac/permission-matrix.json`. `app_user`
menjadi `user_profile` (DB-002 §2). Penugasan role dengan `scope_type`/`scope_id`, masa berlaku, pencabutan,
larangan memberi role kepada diri sendiri, role belum aktif ditolak (`ROLE_NOT_ACTIVE`). RLS memakai nama
permission resmi dan hanya menghormati level `FULL`/`TEAM`; `LIMITED`/`SELF` ditolak bawaan sampai aturannya dibangun.
Hapus fisik `worker` dan `competency_record` dicabut (soft delete).

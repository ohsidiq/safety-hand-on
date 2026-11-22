# Safety On Hand: catatan untuk agen

- Balas dalam bahasa Indonesia. Nama produk: Safety On Hand.
- Sumber kebenaran: vault `docs/` (Decision Baseline > SRS > PRD). Dokumen menang atas kode kecuali pemilik mengubahnya.
- Arsitektur ADR-001 Opsi B. Aturan wajib: ARCH-001 (klien tidak akses tabel), ARCH-002 (kueri bisnis hanya lewat
  `withUser` dari `@soh/db`, RLS tidak boleh dimatikan), ARCH-005/006 (efek samping lewat outbox, handler idempoten),
  ARCH-008 (skema hanya lewat `db/migrations/NNNN_*.sql` berurutan; jangan ubah migrasi yang sudah ada, buat yang baru).
- Kebijakan RLS: nilai konstan ditulis `(select fungsi(...))`; jangan panggil fungsi izin dengan kolom per baris.
- Data sintetis saja (B-24). Jangan pernah memasukkan data pekerja nyata, NIK, atau detail medis nyata.
- Rahasia tidak pernah masuk repo. Hanya nama variabel di `.env.example`.
- Setelah mengubah rute API: `pnpm --filter @soh/api openapi`.
- Sebelum menyatakan selesai: `pnpm lint && pnpm typecheck && pnpm test` dan `bash scripts/test-db.sh` + uji integrasi
  dengan `DATABASE_URL`. Status TESTED hanya bila uji benar-benar dijalankan.

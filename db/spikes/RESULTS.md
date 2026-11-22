# Hasil spike M0 (PostgreSQL lokal, data sintetis)

Tanggal: 2026-11-21. Status: **indikatif**. Dijalankan di PostgreSQL 16.15 lokal (2 vCPU, 8 GB RAM,
`shared_buffers` 512 MB, fsync aktif) dengan skema minimal `db/migrations/0001` dan data sintetis (B-24).
**Bukan Supabase.** Spike harus diulang di proyek Supabase staging sebelum ADR-001 dikunci.

| Spike | Ambang | Hasil lokal | Status |
|---|---|---|---|
| S-1 RLS p95 pada 10.000 pekerja dalam satu tenant | p95 ≤ 500 ms (NFR-PERF-003, 005) | p95 4,3 sampai 15,7 ms pada kebijakan yang dioptimalkan | Lulus lokal |
| S-2 Evaluasi massal 1.000 pekerja | ≤ 60 detik (NFR-PERF-006) | 0,10 sampai 0,15 detik. 10.000 pekerja 0,81 detik. 30.000 pekerja 2,46 detik | Lulus lokal |
| S-3 Outbox dan worker tahan dimatikan paksa | 0 kehilangan (NFR-REL-003) | 50.001 event, 2 kali SIGKILL pada semua proses PostgreSQL, 0 kehilangan, 0 duplikat efek | Lulus lokal |
| S-4 Isolasi tenant pada seluruh tabel | 0 kebocoran (NFR-SEC-001) | 46 pemeriksaan, 0 kebocoran. Uji terbukti gagal saat kebijakan dirusak (3 mutasi) | Lulus lokal |
| S-6 Push PWA | Berfungsi di perangkat target | 2026-11-22: Chrome desktop dan Android lulus; iOS belum | Sebagian |
| S-5, S-7, S-8 | | Ditunda sampai ada data nyata (B-24) | Ditunda |

## S-1: kinerja RLS

Data: 21 tenant. Satu organisasi besar (10.000 pekerja, 20 Site, 500 pekerja per Site) dan 20 organisasi
masing-masing 1.000 pekerja. Total 30.000 pekerja, 114.121 catatan kompetensi, 30.000 status Medical.
Beban: pgbench, 4 klien, 15 detik per skenario, peran login `app_runtime` (RLS berlaku). Setiap transaksi
mengatur pengguna aktif (`app.user_id`) lalu menjalankan kueri seperti permintaan API.

```
A Supervisor daftar (1 Site)       n=7619   p50=    7.7 ms  p95=   11.8 ms  p99=   14.1 ms  max=   20.3 ms
B HSE Mgr daftar (10.000)          n=6117   p50=    9.6 ms  p95=   13.7 ms  p99=   16.3 ms  max=   21.8 ms
C Detail pekerja + kompetensi      n=21630  p50=    2.6 ms  p95=    4.3 ms  p99=    5.0 ms  max=   12.1 ms
D Dashboard WRR (10.000)           n=5398   p50=   10.8 ms  p95=   15.7 ms  p99=   17.8 ms  max=   27.5 ms
E 21 tenant campuran               n=15805  p50=    3.4 ms  p95=    6.8 ms  p99=   12.9 ms  max=   27.0 ms
```

**Temuan desain yang penting.** Bentuk kebijakan menentukan kinerja. Memanggil `has_permission(perm, site_id)`
per baris membuat p95 melonjak 20 sampai 30 kali lipat:

| Skenario | Kebijakan per baris | Kebijakan initplan (dipakai) |
|---|---|---|
| A Supervisor daftar | p95 241,9 ms | p95 12,7 ms |
| B HSE Manager daftar (10.000) | p95 408,0 ms (hampir batas 500 ms) | p95 14,6 ms |

Aturan yang dipakai: nilai konstan dihitung sekali per kueri lewat `(select app.has_org_wide(...))` dan
`site_id = any ((select app.permitted_sites(...))::uuid[])`. **Semua kebijakan RLS berikutnya wajib memakai
bentuk ini** dan ditambahkan ke uji kinerja CI.

Batasan: data seragam, satu mesin, tanpa jaringan antara Core API dan database, tanpa pooler, tanpa beban
penulisan bersamaan. Supabase menambah latensi jaringan dan pooler.

## S-2: evaluasi massal

Prototipe set-based (`s2_evaluate_readiness.sql`): join syarat posisi x bukti terverifikasi x status Medical,
kedaluwarsa sampai akhir hari menurut zona waktu Site (SH-03), hasil di-upsert ke `readiness_snapshot`.

| Jumlah pekerja | Waktu |
|---|---|
| 1.000 (tiga organisasi, tiga kali) | 97 ms, 148 ms, 146 ms |
| 1.000 (ulang, memperbarui) | 143 ms |
| 10.000 | 810 ms |
| 30.000 | 2.461 ms |

Batasan: aturan jauh lebih sederhana daripada SRS-RE (tanpa versi Requirement Profile, riwayat snapshot, kondisi
bersyarat, penulisan outbox dan audit). Margin terhadap ambang 60 detik sekitar 400 kali, sehingga algoritma
yang lebih kompleks kemungkinan tetap lulus, tetapi harus diukur ulang saat M4.

## S-3: outbox tahan crash

Produsen menulis baris bisnis dan event outbox dalam **satu transaksi**. Konsumen mengambil
`FOR UPDATE SKIP LOCKED` dalam batch 50, menulis efek idempoten (`PRIMARY KEY event_id`) dan menandai
`processed_at` dalam transaksi yang sama. Dua kali `kill -9` pada seluruh proses PostgreSQL: pertama saat
produsen dan konsumen sibuk, kedua saat konsumen menguras antrean (21.335 event tertunda). Server dinyalakan
ulang dan pulih otomatis (log server mencatat dua kali crash recovery).

```
setelah pemulihan pertama: bisnis=5721 outbox=5721      (atomisitas: tidak ada bisnis tanpa event)
akhir: bisnis=50001 outbox=50001 diproses=50001 efek=50001 | bisnis tanpa event=0 event tanpa efek=0
```

Batasan: efek diuji di dalam database. Efek eksternal (email, push) tetap at-least-once. Pengiriman harus
memakai kunci idempoten per event (ARCH-006) dan itu diuji di M1 dan seterusnya. Worker di sini disimulasikan
pgbench, bukan proses worker yang sebenarnya.

## S-4: isolasi tenant

`db/tests/rls_isolation.sql`: (T1) setiap tabel ber-`organization_id` wajib RLS aktif, dipaksa, dan punya
kebijakan. (T2) baca lintas tenant pada semua tabel = 0 baris. (T3) tulis lintas tenant ditolak, update dan
delete lintas tenant mengubah 0 baris, kontrol positif menulis ke organisasi sendiri. (T4) Supervisor hanya
melihat Site-nya. (T5) status Medical tidak terlihat Supervisor, detail Medical hanya peran Medical.
(T6) tanpa pengguna tidak melihat apa pun. (T7) FK komposit menolak Site lintas organisasi.
(T8) `audit_log` tidak dapat diubah, dihapus, atau dikosongkan.

Mutasi untuk membuktikan uji bekerja: kebijakan `competency_record_read` dibuat `using (true)` memicu
T2 GAGAL (187 baris organisasi lain), RLS dimatikan pada `worker` memicu T1 GAGAL, Supervisor diberi
`medical.view_status` memicu T5 GAGAL. Setelah dipulihkan uji lulus kembali.

Batasan: peran dan izin di `0002_reference_data.sql` adalah ilustrasi, bukan PB-009. Uji RLS pada skema
penuh (DB-001..DB-008) dan uji matriks permission role x aksi dibuat di M1.

## Cara mengulang

```
export PGHOST=... PGPORT=... PGUSER=... PGPASSWORD=...
bash scripts/test-db.sh                       # migrasi dari nol + S-4
# S-1 / S-2: muat seed besar (lihat db/seed/synthetic_seed.sql), psql -f db/spikes/s2_evaluate_readiness.sql
#            psql -f db/spikes/s1/setup.sql ; PGDATABASE=... db/spikes/s1/run.sh
# S-3: db/spikes/s3/run.sh dengan CRASH_CMD dan START_CMD sesuai lingkungan
```


## Pengulangan di Supabase staging (2026-11-22)

Proyek `soh-staging` (PostgreSQL 17, ap-southeast-1, paket gratis). Diukur di sisi database sebagai `app_authenticated`
(RLS berlaku), satu transaksi yang dibatalkan di akhir (staging tetap bersih, diverifikasi). Lihat `supabase_s1_s2.sql`.

| Spike | Hasil Supabase | Status |
|---|---|---|
| S-1 (organisasi 10.000 pekerja, 20 Site) | A Supervisor p95 9,0 ms; B HSE Manager 10.000 p95 8,4 ms; C detail p95 2,7 ms; D dashboard p95 7,4 ms; 0 kebocoran | Lulus |
| S-2 | 1.000 pekerja 180 ms; 10.000 pekerja 1.553 ms | Lulus |
| S-3 | Tidak diulang (butuh akses OS untuk SIGKILL). Diterima: mekanisme PostgreSQL sama, uji integrasi worker di CI | Diterima |
| S-4 | 62 pemeriksaan, 0 kebocoran (`db/tests/staging/rls_isolation_staging.sql`) | Lulus |
| S-6 | Chrome desktop dan Android lulus (`/uji-push`). iOS belum diuji | Sebagian |

Batasan: tanpa latensi jaringan Core API ke pooler; diukur ujung ke ujung saat endpoint bisnis ada (M1).

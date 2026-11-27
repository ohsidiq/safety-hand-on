-- Jadwal pg_cron di Supabase staging (bukan migrasi: pg_cron khusus Supabase, database uji lokal/CI tidak memilikinya).
-- Dijalankan manual di SQL Editor bila jadwal perlu dipasang ulang. Semua berjalan sebagai app_worker.
-- Catatan 2026-11-27: job 1..3 dipasang saat M1.3/M1.5; job soh-expiry-reminders ditambahkan M3.6a (0022).
-- Catatan 2026-11-28: job 5..6 (Readiness Engine) ditambahkan M4.1 (0023).
-- Nama job sama dengan staging (awalan soh-). Periksa: select jobname, schedule, active from cron.job;

-- 1. Audit: pindahkan audit_outbox ke audit_log tiap menit
select cron.schedule('soh-audit-drain', '* * * * *', $$set role app_worker; select app.audit_drain(500); reset role;$$);
-- 2. Audit: jamin partisi bulanan, harian 02:17 UTC
select cron.schedule('soh-audit-partitions', '17 2 * * *', $$set role app_worker; select app.audit_ensure_partitions(3); reset role;$$);
-- 3. Notifikasi: proses notification_event tiap menit
select cron.schedule('soh-notification-process', '* * * * *', $$set role app_worker; select app.notification_process(200); reset role;$$);
-- 4. Pengingat kedaluwarsa (M3.6a): tiap jam menit ke-7; hari dihitung per zona waktu Site, dedup mencegah ganda
select cron.schedule('soh-expiry-reminders', '7 * * * *', $$set role app_worker; select app.expiry_reminders_enqueue(); reset role;$$);
-- 5. Readiness Engine (M4.1): proses antrean kesiapan tiap menit (debounce 5 detik di dalam fungsi)
select cron.schedule('soh-readiness-process', '* * * * *', $$set role app_worker; select app.readiness_process(500); reset role;$$);
-- 6. Readiness Engine (M4.1): evaluasi terjadwal tiap jam menit ke-13 (jatuh tempo + pekerja yang belum dievaluasi)
select cron.schedule('soh-readiness-due', '13 * * * *', $$set role app_worker; select app.readiness_evaluate_due(1000); reset role;$$);

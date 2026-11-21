# apps/worker

Pemroses `outbox_event` (ARCH-005, ARCH-006): klaim `FOR UPDATE SKIP LOCKED`, savepoint per event, percobaan
ulang sampai `maxAttempts`, lalu antrean gagal (`failed_at`) dengan log galat. Berjalan sebagai peran `app_worker`.
Handler efek eksternal wajib memakai `event.id` sebagai kunci idempoten.

- `pnpm dev` / `pnpm start`: polling terus-menerus
- `pnpm once`: sekali jalan sampai antrean kosong (cocok untuk cron terjadwal di paket gratis)

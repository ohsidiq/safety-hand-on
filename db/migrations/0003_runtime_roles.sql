-- 0003_runtime_roles.sql
-- Peran runtime untuk Core API dan worker (ARCH-002, ARCH-005, ARCH-006).
--
-- Core API: login sebagai peran koneksi, lalu per transaksi
--   set local role app_authenticated; select set_config('app.user_id', <uuid>, true);
-- sehingga semua kueri bisnis terkena RLS.
--
-- Worker: per transaksi `set local role app_worker`. Peran ini hanya boleh membaca dan
-- menandai outbox_event lintas organisasi (bukan BYPASSRLS), sehingga tidak bergantung
-- pada atribut superuser penyedia dan tetap portabel (ARCH-008).

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_worker') then
    create role app_worker nologin;
  end if;
end $$;

-- Kolom pendukung pemrosesan ulang dan antrean gagal (ARCH-006)
alter table outbox_event
  add column if not exists attempts      integer not null default 0,
  add column if not exists last_error    text,
  add column if not exists failed_at     timestamptz;

grant usage on schema public, app to app_worker;
grant select, update (processed_at, attempts, last_error, failed_at) on outbox_event to app_worker;

create policy outbox_event_worker_read on outbox_event for select to app_worker using (true);
create policy outbox_event_worker_update on outbox_event for update to app_worker using (true) with check (true);

-- Peran koneksi (mis. `postgres` di Supabase yang bukan superuser) perlu keanggotaan agar boleh SET ROLE.
-- Pada PostgreSQL lokal sebagai superuser, ini tidak berpengaruh.
grant app_authenticated to current_user;
grant app_worker to current_user;

-- 0004_hardening.sql
-- Pengerasan dari temuan Supabase Security Advisor pada staging (2026-11-22). Portabel: aman di PostgreSQL biasa.
--
-- 1. RLS pada tabel acuan peran dan izin (sebelumnya terbuka di skema yang diekspos PostgREST).
-- 2. search_path dikunci pada fungsi yang belum menetapkannya.
-- 3. ARCH-001: peran klien Supabase (anon, authenticated) tidak punya hak apa pun atas tabel aplikasi.
--    Semua operasi bisnis lewat Core API (app_authenticated). Termasuk hak bawaan untuk objek baru.
-- 4. Tabel pencatat migrasi dilindungi RLS tanpa kebijakan (hanya pemilik).

alter table role            enable row level security; alter table role            force row level security;
alter table permission      enable row level security; alter table permission      force row level security;
alter table role_permission enable row level security; alter table role_permission force row level security;

create policy role_read            on role            for select to app_authenticated using (true);
create policy permission_read      on permission      for select to app_authenticated using (true);
create policy role_permission_read on role_permission for select to app_authenticated using (true);

alter function app.audit_block_change() set search_path = pg_catalog, pg_temp;
alter function app.current_user_id()    set search_path = pg_catalog, pg_temp;

create table if not exists schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now()
);
alter table schema_migrations enable row level security;
alter table schema_migrations force row level security;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema app from %I', r);
      execute format('revoke usage on schema app from %I', r);
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
    end if;
  end loop;
end $$;

-- Fungsi izin tidak perlu dapat dipanggil PUBLIC secara langsung selain oleh peran runtime.
revoke execute on all functions in schema app from public;
grant execute on all functions in schema app to app_authenticated, app_worker;

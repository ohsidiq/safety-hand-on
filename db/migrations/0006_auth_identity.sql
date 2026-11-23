-- 0006: identitas untuk autentikasi (M1.2)
-- Sumber: DB-001 §2 (organization.code, status), DB-001 §8 dan B-18 (worker.user_id sumber kebenaran tunggal,
-- view v_user_worker), DB-002 (role WORKER wajib punya Worker), API-001 §9 (GET /auth/me).
-- Data sintetis saja (B-24).

-- ---------------------------------------------------------------- organization: kode dan status
alter table organization
  add column if not exists code text,
  add column if not exists status text not null default 'ACTIVE';
alter table organization
  add constraint organization_status_chk check (status in ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  add constraint organization_code_chk check (code is null or code ~ '^[A-Z0-9][A-Z0-9-]{1,19}$');
create unique index if not exists organization_code_uq on organization (code) where code is not null;

-- ---------------------------------------------------------------- worker.user_id (B-18)
-- Satu pekerja paling banyak satu akun, satu akun paling banyak satu pekerja, keduanya pada organisasi yang sama.
alter table worker add column if not exists user_id uuid;
alter table worker
  add constraint worker_user_fk foreign key (user_id, organization_id) references user_profile (id, organization_id);
create unique index if not exists worker_user_uq on worker (user_id) where user_id is not null;

-- Arah akun -> pekerja. security_invoker: RLS tabel worker tetap berlaku bagi pemanggil.
create view v_user_worker with (security_invoker = true) as
  select user_id, id as worker_id, organization_id from worker where user_id is not null;
grant select on v_user_worker to app_authenticated;

-- Worker milik pengguna aktif sendiri (untuk GET /auth/me). Hanya mengembalikan id, tidak membuka baris lain.
create function app.my_worker_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select w.id from worker w
  join user_profile up on up.id = w.user_id and up.organization_id = w.organization_id
  where w.user_id = app.current_user_id()
$$;
revoke execute on function app.my_worker_id() from public;
grant execute on function app.my_worker_id() to app_authenticated;

-- ---------------------------------------------------------------- role WORKER wajib punya Worker (DB-001 §8)
create function app.ura_require_worker() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.role_code = 'WORKER' and new.revoked_at is null
     and not exists (select 1 from worker w where w.user_id = new.user_id and w.organization_id = new.organization_id) then
    raise exception 'WORKER_REQUIRED_FOR_ROLE: role WORKER memerlukan Worker yang terhubung' using errcode = '23514';
  end if;
  return new;
end
$$;
revoke execute on function app.ura_require_worker() from public;
create trigger ura_require_worker before insert or update on user_role_assignment
  for each row execute function app.ura_require_worker();

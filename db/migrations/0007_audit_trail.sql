-- 0007: Audit Trail (M1.3)
-- Sumber: SRS-PLT03 v1.1.0, DB-007 §2 dan §5, API-016, DB-008 §2.4.
--
-- Alur: transaksi bisnis -> app.audit_record()/trigger -> audit_outbox (transaksi yang sama)
--       -> app.audit_drain() dijalankan peran app_worker (worker atau penjadwal) -> audit_log.
-- audit_log append-only (trigger baris dan pernyataan), dipartisi per bulan, dibaca lewat RLS + audit.view.
-- Nilai data Sensitif tidak pernah disalin ke audit (AUD-003): pemanggil hanya mengirim nama field untuk data
-- Sensitif; trigger di migrasi ini hanya menyalin nilai field non-sensitif.

-- ---------------------------------------------------------------- 1. ganti audit_log M0 (selalu kosong)
do $$
begin
  if exists (select 1 from audit_log) then
    raise exception 'audit_log M0 berisi data; pemindahan manual diperlukan sebelum migrasi 0007';
  end if;
end $$;
drop table audit_log;

create table audit_log (
  id               uuid not null default gen_random_uuid(),
  occurred_at      timestamptz not null default now(),
  organization_id  uuid,
  site_id          uuid,
  actor_kind       text not null,
  actor_user_id    uuid,
  actor_role_code  text,
  actor_scope_type text,
  actor_scope_id   uuid,
  support_grant_id uuid,
  action           text not null,
  entity_type      text not null,
  entity_id        uuid,
  changed_fields   text[],
  changes          jsonb,
  sensitive_access boolean not null default false,
  access_reason    text,
  result           text not null default 'SUCCESS',
  request_id       text,
  ip               inet,
  user_agent       text,
  prev_hash        bytea,
  row_hash         bytea,
  primary key (id, occurred_at),
  constraint audit_actor_kind_chk check (actor_kind in ('USER', 'SYSTEM', 'SUPPORT')),
  constraint audit_actor_user_chk check (actor_kind = 'SYSTEM' or actor_user_id is not null),
  constraint audit_reason_chk check (not sensitive_access or length(btrim(coalesce(access_reason, ''))) > 0),
  constraint audit_support_chk check (actor_kind <> 'SUPPORT' or support_grant_id is not null),
  constraint audit_result_chk check (result in ('SUCCESS', 'DENIED', 'FAILED')),
  constraint audit_action_chk check (action ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$')
) partition by range (occurred_at);

create index audit_log_org_time_idx   on audit_log (organization_id, occurred_at desc, id desc);
create index audit_log_org_entity_idx on audit_log (organization_id, entity_type, entity_id, occurred_at);
create index audit_log_org_actor_idx  on audit_log (organization_id, actor_user_id, occurred_at);

alter table audit_log enable row level security;
alter table audit_log force row level security;
revoke all on audit_log from public;

-- Append-only: trigger baris (merambat ke partisi) dan trigger TRUNCATE per tabel (tidak merambat).
create trigger audit_log_no_update before update or delete on audit_log
  for each row execute function app.audit_block_change();
create trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function app.audit_block_change();

-- Baca: organisasi sendiri dan audit.view tingkat FULL/TEAM (BR-PLT03-004, AUD-API-002).
create policy audit_log_read on audit_log for select to app_authenticated
  using (organization_id = (select app.current_org()) and (select app.has_org_wide('audit.view')));
grant select on audit_log to app_authenticated;
-- Tulis: hanya pemindah antrean (app_worker). Tidak ada UPDATE/DELETE untuk siapa pun.
create policy audit_log_worker_insert on audit_log for insert to app_worker with check (true);
grant insert on audit_log to app_worker;

-- Partisi bulanan. Partisi bawaan menampung kejadian di luar rentang sehingga tidak ada yang hilang.
create function app.audit_prepare_partition(p_name text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  execute format('alter table %I enable row level security', p_name);
  execute format('alter table %I force row level security', p_name);
  execute format('revoke all on %I from public', p_name);
  execute format('create trigger audit_log_no_truncate before truncate on %I '
                 'for each statement execute function app.audit_block_change()', p_name);
end $$;

create function app.audit_ensure_partitions(p_months_ahead int default 3) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m date;
  v_name text;
  created int := 0;
begin
  for i in -1..greatest(p_months_ahead, 0) loop
    m := (date_trunc('month', now() at time zone 'UTC') + make_interval(months => i))::date;
    v_name := 'audit_log_' || to_char(m, 'YYYYMM');
    if to_regclass('public.' || v_name) is null then
      execute format('create table %I partition of audit_log for values from (%L) to (%L)',
                     v_name, m::text || ' 00:00:00+00', (m + interval '1 month')::date::text || ' 00:00:00+00');
      perform app.audit_prepare_partition(v_name);
      created := created + 1;
    end if;
  end loop;
  return created;
end $$;

create table audit_log_default partition of audit_log default;
select app.audit_prepare_partition('audit_log_default');
select app.audit_ensure_partitions(3);

-- ---------------------------------------------------------------- 2. audit_outbox
-- Tanpa organization_id; RLS aktif tanpa FORCE: pemilik (fungsi SECURITY DEFINER) menulis, app_worker memproses,
-- app_authenticated tidak punya hak langsung sama sekali.
create table audit_outbox (
  id           uuid primary key default gen_random_uuid(),
  payload      jsonb not null,
  created_at   timestamptz not null default clock_timestamp(),
  processed_at timestamptz,
  attempts     integer not null default 0,
  last_error   text,
  failed_at    timestamptz
);
create index audit_outbox_pending_idx on audit_outbox (created_at) where processed_at is null and failed_at is null;
alter table audit_outbox enable row level security;
revoke all on audit_outbox from public;
grant select, update (processed_at, attempts, last_error, failed_at) on audit_outbox to app_worker;
create policy audit_outbox_worker_read on audit_outbox for select to app_worker using (true);
create policy audit_outbox_worker_update on audit_outbox for update to app_worker using (true) with check (true);

-- ---------------------------------------------------------------- 3. pencatatan
-- Penugasan role pelaku yang memberi permission tertentu (actor_role_code dan scope pada SRS-PLT03 §5).
create function app.audit_actor_assignment(p_user uuid, p_permission text)
returns table (role_code text, scope_type text, scope_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select ura.role_code, ura.scope_type, ura.scope_id
  from user_role_assignment ura
  join role_permission rp on rp.role_code = ura.role_code
  where ura.user_id = p_user and rp.permission_code = p_permission
    and rp.constraint_level in ('FULL', 'TEAM')
    and ura.revoked_at is null and ura.valid_from <= now() and (ura.valid_until is null or ura.valid_until > now())
  order by (rp.constraint_level = 'FULL') desc, ura.role_code
  limit 1
$$;

create function app.audit_safe_inet(p text) returns inet
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
begin
  return nullif(p, '')::inet;
exception when others then
  return null;
end $$;

-- Inti pencatatan (internal, tidak diberikan ke peran aplikasi). Konteks permintaan dibaca dari GUC
-- app.request_id, app.ip, app.user_agent yang diatur Core API per transaksi.
create function app.audit_enqueue(
  p_organization_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id uuid default null,
  p_changed_fields text[] default null,
  p_changes jsonb default null,
  p_permission text default null,
  p_site_id uuid default null,
  p_result text default 'SUCCESS',
  p_sensitive boolean default false,
  p_reason text default null,
  p_actor uuid default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid := gen_random_uuid();
  v_actor uuid := coalesce(p_actor, app.current_user_id());
  v_role text;
  v_scope_type text;
  v_scope_id uuid;
begin
  if v_actor is not null and p_permission is not null then
    select x.role_code, x.scope_type, x.scope_id into v_role, v_scope_type, v_scope_id
    from app.audit_actor_assignment(v_actor, p_permission) x;
  end if;
  insert into audit_outbox (id, payload) values (v_id, jsonb_strip_nulls(jsonb_build_object(
    'occurred_at', clock_timestamp(),
    'organization_id', p_organization_id,
    'site_id', p_site_id,
    'actor_kind', case when v_actor is null then 'SYSTEM' else 'USER' end,
    'actor_user_id', v_actor,
    'actor_role_code', v_role,
    'actor_scope_type', v_scope_type,
    'actor_scope_id', v_scope_id,
    'action', p_action,
    'entity_type', p_entity_type,
    'entity_id', p_entity_id,
    'changed_fields', to_jsonb(p_changed_fields),
    'changes', p_changes,
    'sensitive_access', coalesce(p_sensitive, false),
    'access_reason', p_reason,
    'result', coalesce(p_result, 'SUCCESS'),
    'request_id', nullif(current_setting('app.request_id', true), ''),
    'ip', nullif(current_setting('app.ip', true), ''),
    'user_agent', left(nullif(current_setting('app.user_agent', true), ''), 500)
  )));
  return v_id;
end $$;

-- Pencatatan dari Core API: organisasi selalu organisasi pelaku (tidak dapat dipalsukan pemanggil).
create function app.audit_record(
  p_action text,
  p_entity_type text,
  p_entity_id uuid default null,
  p_changed_fields text[] default null,
  p_changes jsonb default null,
  p_permission text default null,
  p_site_id uuid default null,
  p_result text default 'SUCCESS',
  p_sensitive boolean default false,
  p_reason text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if app.current_user_id() is null then
    raise exception 'audit_record memerlukan pengguna aktif' using errcode = '42501';
  end if;
  return app.audit_enqueue(app.current_org(), p_action, p_entity_type, p_entity_id, p_changed_fields, p_changes,
                           p_permission, p_site_id, p_result, p_sensitive, p_reason);
end $$;

-- Pemindah antrean (idempoten: id kejadian = id outbox, ON CONFLICT DO NOTHING). Dipanggil sebagai app_worker.
-- Kejadian yang gagal 5 kali dipindah ke antrean gagal (failed_at), tidak dihapus, dan memicu peringatan (AUD-009).
create function app.audit_drain(p_batch int default 500) returns table (moved int, failed int)
language plpgsql set search_path = public, pg_temp as $$
declare
  r record;
  p jsonb;
  v_moved int := 0;
  v_failed int := 0;
begin
  for r in
    select o.id, o.payload, o.attempts from audit_outbox o
    where o.processed_at is null and o.failed_at is null
    order by o.created_at
    limit greatest(p_batch, 1)
    for update skip locked
  loop
    begin
      p := r.payload;
      insert into audit_log (id, occurred_at, organization_id, site_id, actor_kind, actor_user_id, actor_role_code,
                             actor_scope_type, actor_scope_id, support_grant_id, action, entity_type, entity_id,
                             changed_fields, changes, sensitive_access, access_reason, result, request_id, ip, user_agent)
      values (r.id, (p->>'occurred_at')::timestamptz, (p->>'organization_id')::uuid, (p->>'site_id')::uuid,
              p->>'actor_kind', (p->>'actor_user_id')::uuid, p->>'actor_role_code', p->>'actor_scope_type',
              (p->>'actor_scope_id')::uuid, (p->>'support_grant_id')::uuid, p->>'action', p->>'entity_type',
              (p->>'entity_id')::uuid,
              case when jsonb_typeof(p->'changed_fields') = 'array'
                   then array(select jsonb_array_elements_text(p->'changed_fields')) end,
              p->'changes', coalesce((p->>'sensitive_access')::boolean, false), p->>'access_reason',
              coalesce(p->>'result', 'SUCCESS'), p->>'request_id', app.audit_safe_inet(p->>'ip'), p->>'user_agent')
      on conflict do nothing;
      update audit_outbox set processed_at = clock_timestamp(), attempts = r.attempts + 1, last_error = null
      where id = r.id;
      v_moved := v_moved + 1;
    exception when others then
      update audit_outbox
      set attempts = r.attempts + 1,
          last_error = left(sqlerrm, 500),
          failed_at = case when r.attempts + 1 >= 5 then clock_timestamp() end
      where id = r.id;
      if r.attempts + 1 >= 5 then
        v_failed := v_failed + 1;
        raise warning 'AUDIT_EVENT_FAILED id=% error=%', r.id, left(sqlerrm, 200);
      end if;
    end;
  end loop;
  return query select v_moved, v_failed;
end $$;

-- ---------------------------------------------------------------- 4. kejadian otomatis
-- 4a. Penugasan role (access.role_assigned / access.role_revoked / access.role_updated, IAM-API-010).
create function app.audit_ura() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_changes jsonb := jsonb_build_object(
    'user_id', new.user_id, 'role_code', new.role_code, 'scope_type', new.scope_type, 'scope_id', new.scope_id,
    'valid_from', new.valid_from, 'valid_until', new.valid_until);
begin
  if tg_op = 'INSERT' then
    perform app.audit_enqueue(new.organization_id, 'access.role_assigned', 'user_role_assignment', new.id,
      array['role_code', 'scope_type', 'scope_id', 'valid_from', 'valid_until'], v_changes, 'role.manage',
      case when new.scope_type = 'SITE' then new.scope_id end, 'SUCCESS', false, null,
      coalesce(app.current_user_id(), new.granted_by));
  elsif old.revoked_at is null and new.revoked_at is not null then
    perform app.audit_enqueue(new.organization_id, 'access.role_revoked', 'user_role_assignment', new.id,
      array['revoked_at'], v_changes || jsonb_build_object('revoked_at', new.revoked_at), 'role.manage',
      case when new.scope_type = 'SITE' then new.scope_id end, 'SUCCESS', false, null,
      coalesce(app.current_user_id(), new.revoked_by));
  elsif (old.valid_from, old.valid_until, old.scope_id) is distinct from (new.valid_from, new.valid_until, new.scope_id) then
    perform app.audit_enqueue(new.organization_id, 'access.role_updated', 'user_role_assignment', new.id,
      array['valid_from', 'valid_until', 'scope_id'], v_changes, 'role.manage',
      case when new.scope_type = 'SITE' then new.scope_id end);
  end if;
  return null;
end $$;
create trigger audit_ura after insert or update on user_role_assignment
  for each row execute function app.audit_ura();

-- 4b. Profil pengguna: pembuatan dan perubahan status. Nama, email, telepon hanya sebagai nama field.
create function app.audit_user_profile() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_fields text[];
begin
  if tg_op = 'INSERT' then
    perform app.audit_enqueue(new.organization_id, 'user.create', 'user_profile', new.id,
      array['status'], jsonb_build_object('status', new.status), 'user.manage');
    return null;
  end if;
  if old.status is distinct from new.status then
    perform app.audit_enqueue(new.organization_id,
      case new.status when 'DEACTIVATED' then 'user.deactivate' when 'LOCKED' then 'user.lock'
                      when 'ACTIVE' then 'user.reactivate' else 'user.update' end,
      'user_profile', new.id, array['status'],
      jsonb_build_object('status', jsonb_build_object('from', old.status, 'to', new.status)), 'user.manage');
  end if;
  v_fields := array_remove(array[
    case when old.full_name is distinct from new.full_name then 'full_name' end,
    case when old.email is distinct from new.email then 'email' end,
    case when old.phone is distinct from new.phone then 'phone' end,
    case when old.preferred_language is distinct from new.preferred_language then 'preferred_language' end], null);
  if cardinality(v_fields) > 0 then
    perform app.audit_enqueue(new.organization_id, 'user.update', 'user_profile', new.id, v_fields, null, 'user.manage');
  end if;
  return null;
end $$;
create trigger audit_user_profile after insert or update on user_profile
  for each row execute function app.audit_user_profile();

-- 4c. Login: sesi Supabase Auth pertama kali dipakai ke Core API (AUD-007). Supabase tidak menyimpan
-- log autentikasi di database proyek ini, jadi login gagal belum tercatat di sini (lihat catatan M1.3).
create table auth_session_seen (
  session_id    uuid primary key,
  user_id       uuid not null,
  first_seen_at timestamptz not null default now()
);
alter table auth_session_seen enable row level security;
revoke all on auth_session_seen from public;

create function app.audit_session_seen(p_session_id uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := app.current_user_id();
  v_new boolean;
begin
  if v_user is null or p_session_id is null then
    return false;
  end if;
  insert into auth_session_seen (session_id, user_id) values (p_session_id, v_user)
  on conflict (session_id) do nothing;
  get diagnostics v_new = row_count;
  if v_new then
    perform app.audit_enqueue((select organization_id from user_profile where id = v_user),
      'auth.login_success', 'user_profile', v_user, null, null, null);
  end if;
  return v_new;
end $$;

-- ---------------------------------------------------------------- 5. hak eksekusi
revoke execute on function app.audit_prepare_partition(text), app.audit_ensure_partitions(int),
  app.audit_actor_assignment(uuid, text), app.audit_safe_inet(text),
  app.audit_enqueue(uuid, text, text, uuid, text[], jsonb, text, uuid, text, boolean, text, uuid),
  app.audit_record(text, text, uuid, text[], jsonb, text, uuid, text, boolean, text),
  app.audit_drain(int), app.audit_ura(), app.audit_user_profile(), app.audit_session_seen(uuid)
  from public;
grant execute on function app.audit_record(text, text, uuid, text[], jsonb, text, uuid, text, boolean, text),
  app.audit_session_seen(uuid) to app_authenticated;
grant execute on function app.audit_drain(int), app.audit_ensure_partitions(int), app.audit_safe_inet(text)
  to app_worker;

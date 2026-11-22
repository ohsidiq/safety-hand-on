-- 0001_m0_foundation_minimal.sql
-- Skema minimal M0 untuk spike S-1..S-4 dan kerangka uji RLS.
-- BUKAN skema akhir: DB-000..DB-008 menggantikan dan memperluas ini di M1 dan M2.
-- Pola yang dibuktikan di sini: isolasi tenant lewat RLS, FK komposit,
-- cakupan Site, pemisahan data Medical, outbox transaksional, audit append-only.

create schema if not exists app;

-- Peran database untuk akses dari Core API. Rahasia dan login ditangani di luar migrasi.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_authenticated') then
    create role app_authenticated nologin;
  end if;
end $$;

-- ---------------------------------------------------------------- tabel inti
create table organization (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table site (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organization(id),
  name             text not null,
  timezone         text not null default 'Asia/Jakarta',
  unique (id, organization_id)
);

create table app_user (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organization(id),
  email            text not null,
  unique (organization_id, email),
  unique (id, organization_id)
);

create table role (code text primary key);
create table permission (code text primary key);
create table role_permission (
  role_code        text not null references role(code),
  permission_code  text not null references permission(code),
  primary key (role_code, permission_code)
);

-- site_id NULL = berlaku untuk seluruh organisasi
create table user_role_assignment (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null,
  organization_id  uuid not null,
  role_code        text not null references role(code),
  site_id          uuid,
  foreign key (user_id, organization_id) references app_user(id, organization_id),
  foreign key (site_id, organization_id) references site(id, organization_id)
);
create index user_role_assignment_user_idx on user_role_assignment(user_id);

create table worker (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null,
  site_id           uuid not null,
  full_name         text not null,
  job_position      text not null,
  employment_status text not null check (employment_status in ('EMPLOYEE','CONTRACTOR')),
  created_at        timestamptz not null default now(),
  foreign key (site_id, organization_id) references site(id, organization_id),
  unique (id, organization_id, site_id)
);
create index worker_org_name_idx on worker(organization_id, full_name);
create index worker_org_site_idx on worker(organization_id, site_id);

-- Syarat per posisi (disederhanakan; Requirement Profile penuh dibangun di M4)
create table requirement_item (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organization(id),
  job_position     text not null,
  requirement_name text not null,
  warning_days     int  not null default 30 check (warning_days between 0 and 365),
  unique (organization_id, job_position, requirement_name)
);

create table competency_record (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  site_id          uuid not null,
  worker_id        uuid not null,
  requirement_name text not null,
  expires_on       date not null,
  verified_at      timestamptz,
  foreign key (worker_id, organization_id, site_id) references worker(id, organization_id, site_id)
);
create index competency_record_worker_idx on competency_record(worker_id);

-- Status Medical (boleh dilihat peran HSE) dan detail Medical (hanya peran khusus)
create table medical_status (
  worker_id        uuid primary key,
  organization_id  uuid not null,
  site_id          uuid not null,
  status           text not null check (status in ('FIT','UNFIT')),
  expires_on       date not null,
  foreign key (worker_id, organization_id, site_id) references worker(id, organization_id, site_id)
);

create table medical_detail (
  worker_id        uuid primary key,
  organization_id  uuid not null,
  site_id          uuid not null,
  detail           text not null,
  foreign key (worker_id, organization_id, site_id) references worker(id, organization_id, site_id)
);

create table readiness_snapshot (
  worker_id        uuid primary key,
  organization_id  uuid not null,
  site_id          uuid not null,
  status           text not null check (status in ('READY','CONDITIONAL','NOT_READY')),
  reasons          jsonb not null default '[]'::jsonb,
  evaluated_at     timestamptz not null default now(),
  foreign key (worker_id, organization_id, site_id) references worker(id, organization_id, site_id)
);
create index readiness_snapshot_org_status_idx on readiness_snapshot(organization_id, status);

-- Outbox transaksional (ARCH-005)
create table outbox_event (
  id               bigserial primary key,
  organization_id  uuid not null,
  event_type       text not null,
  payload          jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  processed_at     timestamptz
);
create index outbox_event_pending_idx on outbox_event(id) where processed_at is null;

-- Audit append-only (ARCH-004)
create table audit_log (
  id               bigserial primary key,
  organization_id  uuid not null,
  actor_user_id    uuid,
  action           text not null,
  entity           text not null,
  entity_id        uuid,
  at               timestamptz not null default now()
);

create function app.audit_block_change() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log bersifat append-only (%).', tg_op using errcode = '42501';
end $$;
create trigger audit_log_no_update before update or delete on audit_log
  for each row execute function app.audit_block_change();
create trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function app.audit_block_change();

-- ------------------------------------------------- fungsi identitas dan izin
-- Pengguna aktif dibaca dari GUC app.user_id. Pada Supabase nilainya berasal dari klaim JWT
-- (mis. auth.uid()). Core API mengatur nilai ini per transaksi.
create function app.current_user_id() returns uuid language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create function app.current_org() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select organization_id from app_user where id = app.current_user_id()
$$;

-- Izin berlaku di seluruh organisasi
create function app.has_org_wide(perm text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from user_role_assignment ura
    join role_permission rp on rp.role_code = ura.role_code
    where ura.user_id = app.current_user_id()
      and ura.site_id is null
      and rp.permission_code = perm)
$$;

-- Daftar Site tempat pengguna punya izin (dihitung sekali per kueri bila dipakai sebagai initplan)
create function app.permitted_sites(perm text) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct ura.site_id), '{}'::uuid[])
  from user_role_assignment ura
  join role_permission rp on rp.role_code = ura.role_code
  where ura.user_id = app.current_user_id()
    and ura.site_id is not null
    and rp.permission_code = perm
$$;

-- Varian per baris (lebih lambat). Dipakai sebagai pembanding pada spike S-1.
create function app.has_permission(perm text, p_site uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from user_role_assignment ura
    join role_permission rp on rp.role_code = ura.role_code
    where ura.user_id = app.current_user_id()
      and rp.permission_code = perm
      and (ura.site_id is null or ura.site_id = p_site))
$$;

-- --------------------------------------------------------------------- RLS
-- Aturan Site: izin organisasi penuh ATAU Site termasuk daftar Site berizin.
-- (select ...) membuat nilai konstan dihitung sekali per kueri.
alter table organization         enable row level security; alter table organization         force row level security;
alter table site                 enable row level security; alter table site                 force row level security;
alter table app_user             enable row level security; alter table app_user             force row level security;
alter table user_role_assignment enable row level security; alter table user_role_assignment force row level security;
alter table worker               enable row level security; alter table worker               force row level security;
alter table requirement_item     enable row level security; alter table requirement_item     force row level security;
alter table competency_record    enable row level security; alter table competency_record    force row level security;
alter table medical_status       enable row level security; alter table medical_status       force row level security;
alter table medical_detail       enable row level security; alter table medical_detail       force row level security;
alter table readiness_snapshot   enable row level security; alter table readiness_snapshot   force row level security;
alter table outbox_event         enable row level security; alter table outbox_event         force row level security;
alter table audit_log            enable row level security; alter table audit_log            force row level security;

create policy organization_read on organization for select
  using (id = (select app.current_org()));

create policy site_read on site for select
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('site.view')) or id = any ((select app.permitted_sites('site.view'))::uuid[])));

create policy app_user_read on app_user for select
  using (organization_id = (select app.current_org()) and (select app.has_org_wide('user.view')));

create policy user_role_assignment_read on user_role_assignment for select
  using (organization_id = (select app.current_org()) and (select app.has_org_wide('user.view')));

create policy worker_read on worker for select
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('worker.view')) or site_id = any ((select app.permitted_sites('worker.view'))::uuid[])));
create policy worker_write on worker for all
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('worker.manage')) or site_id = any ((select app.permitted_sites('worker.manage'))::uuid[])))
  with check (organization_id = (select app.current_org())
         and ((select app.has_org_wide('worker.manage')) or site_id = any ((select app.permitted_sites('worker.manage'))::uuid[])));

create policy requirement_item_read on requirement_item for select
  using (organization_id = (select app.current_org()));

create policy competency_record_read on competency_record for select
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('competency.view')) or site_id = any ((select app.permitted_sites('competency.view'))::uuid[])));
create policy competency_record_write on competency_record for all
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('competency.manage')) or site_id = any ((select app.permitted_sites('competency.manage'))::uuid[])))
  with check (organization_id = (select app.current_org())
         and ((select app.has_org_wide('competency.manage')) or site_id = any ((select app.permitted_sites('competency.manage'))::uuid[])));

create policy medical_status_read on medical_status for select
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('medical.view_status')) or site_id = any ((select app.permitted_sites('medical.view_status'))::uuid[])));

-- Detail Medical: hanya izin tingkat organisasi, tanpa jalur per Site
create policy medical_detail_read on medical_detail for select
  using (organization_id = (select app.current_org()) and (select app.has_org_wide('medical.view_detail')));

create policy readiness_snapshot_read on readiness_snapshot for select
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('readiness.view')) or site_id = any ((select app.permitted_sites('readiness.view'))::uuid[])));

-- Outbox: klien boleh menambah baris untuk organisasinya, tidak boleh membaca
create policy outbox_event_insert on outbox_event for insert
  with check (organization_id = (select app.current_org()));

create policy audit_log_read on audit_log for select
  using (organization_id = (select app.current_org()) and (select app.has_org_wide('audit.view')));
create policy audit_log_insert on audit_log for insert
  with check (organization_id = (select app.current_org()));

-- --------------------------------------------------------------------- hak
grant usage on schema public, app to app_authenticated;
grant select on organization, site, app_user, user_role_assignment, requirement_item,
                competency_record, medical_status, medical_detail, readiness_snapshot,
                role, permission, role_permission to app_authenticated;
grant select, insert, update, delete on worker to app_authenticated;
grant insert, update, delete on competency_record to app_authenticated;
grant insert on outbox_event, audit_log to app_authenticated;
grant usage on sequence outbox_event_id_seq, audit_log_id_seq to app_authenticated;

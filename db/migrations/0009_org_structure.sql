-- 0009: Struktur organisasi (M2.1)
-- Sumber: DB-001 v2.4 §2-§7 dan §10, SRS-WF001, API-002 §3-§10, PB-009 v3.5, B-12, B-23, B-25.
-- Data sintetis saja (B-24). Tidak ada penghapusan fisik: penonaktifan lewat status (ORG-API-003, ER-009).

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------- 0. utilitas
-- Zona waktu IANA valid (ORG-API-006, ER-010). Dipakai trigger karena CHECK tidak boleh membaca katalog.
create function app.is_valid_timezone(p text) returns boolean
language sql stable set search_path = pg_catalog, pg_temp as $$
  select p is not null and exists (select 1 from pg_timezone_names where name = p)
$$;

create function app.check_timezone() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v text := to_jsonb(new) ->> case tg_table_name when 'organization' then 'default_timezone' else 'timezone' end;
begin
  if not app.is_valid_timezone(v) then
    raise exception 'INVALID_TIMEZONE: % bukan zona waktu IANA yang valid', v using errcode = '23514';
  end if;
  return new;
end $$;

-- Format kode bersama (API-002 §10): huruf besar, angka, tanda hubung, 2..30 karakter.
create domain app.code_text as text check (value ~ '^[A-Z0-9][A-Z0-9-]{1,29}$');

-- ---------------------------------------------------------------- 1. organization
alter table organization
  add column default_timezone text not null default 'Asia/Jakarta',
  add column settings jsonb not null default '{}',
  add column plan text;
create trigger organization_timezone before insert or update of default_timezone on organization
  for each row execute function app.check_timezone();
-- organization.manage (FULL, tingkat organisasi) boleh mengubah nama dan zona waktu bawaan.
-- `settings` diubah lewat API khusus configuration.manage (menyusul), tidak lewat hak kolom ini.
grant update (name, default_timezone) on organization to app_authenticated;
create policy organization_update on organization for update to app_authenticated
  using (id = (select app.current_org()) and (select app.has_org_wide('organization.manage')))
  with check (id = (select app.current_org()));

-- ---------------------------------------------------------------- 2. site
alter table site
  add column code text,
  add column location text,
  add column status text not null default 'ACTIVE',
  add column created_at timestamptz not null default now();
update site s set timezone = coalesce(s.timezone, o.default_timezone) from organization o where o.id = s.organization_id;
update site s set code = 'SITE-' || x.n
from (select id, row_number() over (partition by organization_id order by name, id) n from site) x where x.id = s.id;
alter table site
  alter column code type app.code_text,
  alter column code set not null,
  alter column timezone set not null,
  add constraint site_status_chk check (status in ('ACTIVE', 'INACTIVE')),
  add constraint site_name_chk check (length(btrim(name)) between 2 and 150);
create unique index site_code_uq on site (organization_id, code) where status = 'ACTIVE';
create trigger site_timezone before insert or update of timezone on site
  for each row execute function app.check_timezone();

-- ---------------------------------------------------------------- 3. department, division, team
create table department (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  site_id         uuid not null,
  name            text not null check (length(btrim(name)) between 2 and 150),
  code            app.code_text not null,
  status          text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  created_at      timestamptz not null default now(),
  foreign key (site_id, organization_id) references site (id, organization_id),
  unique (id, organization_id),
  unique (id, site_id)
);
create unique index department_code_uq on department (site_id, code) where status = 'ACTIVE';
create index department_org_site_idx on department (organization_id, site_id);

-- Division opsional di bawah Department. site_id disimpan (FK komposit ke department) agar RLS scope Site berlaku.
create table division (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  site_id         uuid not null,
  department_id   uuid not null,
  name            text not null check (length(btrim(name)) between 2 and 150),
  code            app.code_text not null,
  status          text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  created_at      timestamptz not null default now(),
  foreign key (department_id, site_id) references department (id, site_id),
  foreign key (site_id, organization_id) references site (id, organization_id),
  unique (id, organization_id)
);
create unique index division_code_uq on division (department_id, code) where status = 'ACTIVE';

-- Team di bawah Site (dan opsional Department pada Site yang sama). Dasar scope Tim Supervisor (PB-008).
create table team (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  site_id         uuid not null,
  department_id   uuid,
  name            text not null check (length(btrim(name)) between 2 and 150),
  code            app.code_text not null,
  status          text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  created_at      timestamptz not null default now(),
  foreign key (site_id, organization_id) references site (id, organization_id),
  foreign key (department_id, site_id) references department (id, site_id),
  unique (id, organization_id),
  unique (id, site_id)
);
create unique index team_code_uq on team (site_id, code) where status = 'ACTIVE';

-- Pekerja dirujuk dengan FK komposit (id, organization_id)
alter table worker add constraint worker_id_org_uq unique (id, organization_id);

-- Keanggotaan bertanggal, tidak dihapus (BR-WF001-008). Tidak tumpang tindih per team dan pekerja (API-002 §10).
create table team_member (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  team_id         uuid not null,
  worker_id       uuid not null,
  valid_from      date not null,
  valid_until     date,
  created_at      timestamptz not null default now(),
  foreign key (team_id, organization_id) references team (id, organization_id),
  foreign key (worker_id, organization_id) references worker (id, organization_id),
  constraint team_member_range_chk check (valid_until is null or valid_until >= valid_from),
  constraint team_member_no_overlap exclude using gist (
    team_id with =, worker_id with =, daterange(valid_from, valid_until, '[]') with &&)
);
create index team_member_worker_idx on team_member (worker_id) where valid_until is null;

-- ---------------------------------------------------------------- 4. job_position, equipment_class (level organisasi)
create table job_position (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organization (id),
  name            text not null check (length(btrim(name)) between 2 and 150),
  code            app.code_text not null,
  job_family      text,
  description     text,
  status          text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  created_at      timestamptz not null default now(),
  unique (id, organization_id)
);
create unique index job_position_code_uq on job_position (organization_id, code) where status = 'ACTIVE';

create table equipment_class (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organization (id),
  name            text not null check (length(btrim(name)) between 2 and 150),
  code            app.code_text not null,
  description     text,
  status          text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  created_at      timestamptz not null default now(),
  unique (id, organization_id)
);
create unique index equipment_class_code_uq on equipment_class (organization_id, code) where status = 'ACTIVE';

-- ---------------------------------------------------------------- 5. contractor dan contractor_site (B-23)
create table contractor (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references organization (id),
  name                  text not null check (length(btrim(name)) between 2 and 150),
  code                  app.code_text not null,
  legal_registration_no text,
  status                text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  contract_start        date,
  contract_end          date,
  created_at            timestamptz not null default now(),
  constraint contractor_contract_chk check (contract_end is null or contract_start is null or contract_end >= contract_start),
  unique (id, organization_id)
);
create unique index contractor_code_uq on contractor (organization_id, code) where status = 'ACTIVE';

create table contractor_site (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  contractor_id   uuid not null,
  site_id         uuid not null,
  valid_from      date not null default current_date,
  valid_until     date,
  created_at      timestamptz not null default now(),
  foreign key (contractor_id, organization_id) references contractor (id, organization_id),
  foreign key (site_id, organization_id) references site (id, organization_id),
  constraint contractor_site_range_chk check (valid_until is null or valid_until >= valid_from)
);
create unique index contractor_site_active_uq on contractor_site (organization_id, contractor_id, site_id) where valid_until is null;

-- ---------------------------------------------------------------- 6. RLS dan hak
-- Baca: organization.read (scope Site untuk tabel bersite). Tulis: organization.manage. Kontraktor: contractor.*.
-- Tanpa DELETE untuk siapa pun (ORG-API-003). Konstanta ditulis (select fn(...)) (aturan CLAUDE.md).
do $$
declare
  t text;
begin
  foreach t in array array['department', 'division', 'team', 'team_member', 'job_position', 'equipment_class',
                           'contractor', 'contractor_site'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('revoke all on %I from public', t);
    execute format('grant select, insert, update on %I to app_authenticated', t);
  end loop;
end $$;
grant insert on site to app_authenticated;
grant update (name, code, location, timezone, status) on site to app_authenticated;

-- site (kebijakan baca sudah ada sejak 0005)
create policy site_insert on site for insert to app_authenticated
  with check (organization_id = (select app.current_org()) and (select app.has_org_wide('organization.manage')));
create policy site_update on site for update to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('organization.manage')) or id = any ((select app.permitted_sites('organization.manage'))::uuid[])))
  with check (organization_id = (select app.current_org()));

-- department, division, team: scope Site
create policy department_read on department for select to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('organization.read')) or site_id = any ((select app.permitted_sites('organization.read'))::uuid[])));
create policy department_insert on department for insert to app_authenticated
  with check (organization_id = (select app.current_org())
              and ((select app.has_org_wide('organization.manage')) or site_id = any ((select app.permitted_sites('organization.manage'))::uuid[])));
create policy department_update on department for update to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('organization.manage')) or site_id = any ((select app.permitted_sites('organization.manage'))::uuid[])))
  with check (organization_id = (select app.current_org()));

create policy division_read on division for select to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('organization.read')) or site_id = any ((select app.permitted_sites('organization.read'))::uuid[])));
create policy division_insert on division for insert to app_authenticated
  with check (organization_id = (select app.current_org())
              and ((select app.has_org_wide('organization.manage')) or site_id = any ((select app.permitted_sites('organization.manage'))::uuid[])));
create policy division_update on division for update to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('organization.manage')) or site_id = any ((select app.permitted_sites('organization.manage'))::uuid[])))
  with check (organization_id = (select app.current_org()));

create policy team_read on team for select to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('organization.read')) or site_id = any ((select app.permitted_sites('organization.read'))::uuid[])));
create policy team_insert on team for insert to app_authenticated
  with check (organization_id = (select app.current_org())
              and ((select app.has_org_wide('organization.manage')) or site_id = any ((select app.permitted_sites('organization.manage'))::uuid[])));
create policy team_update on team for update to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('organization.manage')) or site_id = any ((select app.permitted_sites('organization.manage'))::uuid[])))
  with check (organization_id = (select app.current_org()));

-- team_member mengikuti Site team-nya
create policy team_member_read on team_member for select to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('organization.read'))
              or team_id in (select t.id from team t where t.site_id = any ((select app.permitted_sites('organization.read'))::uuid[]))));
create policy team_member_insert on team_member for insert to app_authenticated
  with check (organization_id = (select app.current_org())
              and ((select app.has_org_wide('organization.manage'))
                   or team_id in (select t.id from team t where t.site_id = any ((select app.permitted_sites('organization.manage'))::uuid[]))));
create policy team_member_update on team_member for update to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('organization.manage'))
              or team_id in (select t.id from team t where t.site_id = any ((select app.permitted_sites('organization.manage'))::uuid[]))))
  with check (organization_id = (select app.current_org()));

-- job_position, equipment_class: entitas organisasi. Baca bagi pemegang organization.read di scope mana pun;
-- tulis hanya organization.manage tingkat organisasi (API-002 §5: Company Admin).
create policy job_position_read on job_position for select to app_authenticated
  using (organization_id = (select app.current_org()) and (select app.has_any_scope('organization.read')));
create policy job_position_insert on job_position for insert to app_authenticated
  with check (organization_id = (select app.current_org()) and (select app.has_org_wide('organization.manage')));
create policy job_position_update on job_position for update to app_authenticated
  using (organization_id = (select app.current_org()) and (select app.has_org_wide('organization.manage')))
  with check (organization_id = (select app.current_org()));

create policy equipment_class_read on equipment_class for select to app_authenticated
  using (organization_id = (select app.current_org()) and (select app.has_any_scope('organization.read')));
create policy equipment_class_insert on equipment_class for insert to app_authenticated
  with check (organization_id = (select app.current_org()) and (select app.has_org_wide('organization.manage')));
create policy equipment_class_update on equipment_class for update to app_authenticated
  using (organization_id = (select app.current_org()) and (select app.has_org_wide('organization.manage')))
  with check (organization_id = (select app.current_org()));

-- contractor, contractor_site: contractor.read / contractor.manage (PB-009 v3.3; Site Admin LIMITED = ditolak bawaan)
create policy contractor_read on contractor for select to app_authenticated
  using (organization_id = (select app.current_org()) and (select app.has_any_scope('contractor.read')));
create policy contractor_insert on contractor for insert to app_authenticated
  with check (organization_id = (select app.current_org()) and (select app.has_any_scope('contractor.manage')));
create policy contractor_update on contractor for update to app_authenticated
  using (organization_id = (select app.current_org()) and (select app.has_any_scope('contractor.manage')))
  with check (organization_id = (select app.current_org()));

create policy contractor_site_read on contractor_site for select to app_authenticated
  using (organization_id = (select app.current_org()) and (select app.has_any_scope('contractor.read')));
create policy contractor_site_insert on contractor_site for insert to app_authenticated
  with check (organization_id = (select app.current_org()) and (select app.has_any_scope('contractor.manage')));
create policy contractor_site_update on contractor_site for update to app_authenticated
  using (organization_id = (select app.current_org()) and (select app.has_any_scope('contractor.manage')))
  with check (organization_id = (select app.current_org()));

-- ---------------------------------------------------------------- 7. audit perubahan struktur (ORG-API-010)
-- Data struktur organisasi bukan kelas Sensitif, sehingga nilai lama dan baru boleh dicatat (DB-007 §2).
create function app.audit_structure_change() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_entity text := tg_argv[0];
  v_perm text := tg_argv[1];
  v_new jsonb := to_jsonb(new);
  v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end;
  v_action text;
  v_fields text[];
  v_changes jsonb;
  v_site uuid := coalesce((v_new->>'site_id')::uuid, case when tg_table_name = 'site' then new.id end);
  v_org uuid := coalesce((v_new->>'organization_id')::uuid, case when tg_table_name = 'organization' then new.id end);
begin
  if tg_op = 'INSERT' then
    v_action := case when tg_table_name = 'team_member' then 'team.member_add' else v_entity || '.create' end;
    select array_agg(k order by k), jsonb_object_agg(k, v_new->k) into v_fields, v_changes
    from jsonb_object_keys(v_new) k where k not in ('id', 'organization_id', 'created_at');
  else
    select array_agg(k order by k), jsonb_object_agg(k, jsonb_build_object('from', v_old->k, 'to', v_new->k))
    into v_fields, v_changes
    from jsonb_object_keys(v_new) k where v_new->k is distinct from v_old->k and k not in ('settings');
    if v_fields is null then
      return null;
    end if;
    v_action := case
      when tg_table_name = 'team_member' and v_old->>'valid_until' is null and v_new->>'valid_until' is not null then 'team.member_end'
      when v_new->>'status' = 'INACTIVE' and v_old->>'status' = 'ACTIVE' then v_entity || '.deactivate'
      when v_new->>'status' = 'ACTIVE' and v_old->>'status' = 'INACTIVE' then v_entity || '.reactivate'
      else v_entity || '.update' end;
  end if;
  perform app.audit_enqueue(v_org, v_action, tg_table_name, new.id, v_fields, v_changes, v_perm, v_site);
  return null;
end $$;
revoke execute on function app.audit_structure_change() from public;

create trigger audit_organization after update on organization
  for each row execute function app.audit_structure_change('organization', 'organization.manage');
create trigger audit_site after insert or update on site
  for each row execute function app.audit_structure_change('site', 'organization.manage');
create trigger audit_department after insert or update on department
  for each row execute function app.audit_structure_change('department', 'organization.manage');
create trigger audit_division after insert or update on division
  for each row execute function app.audit_structure_change('division', 'organization.manage');
create trigger audit_team after insert or update on team
  for each row execute function app.audit_structure_change('team', 'organization.manage');
create trigger audit_team_member after insert or update on team_member
  for each row execute function app.audit_structure_change('team', 'organization.manage');
create trigger audit_job_position after insert or update on job_position
  for each row execute function app.audit_structure_change('job_position', 'organization.manage');
create trigger audit_equipment_class after insert or update on equipment_class
  for each row execute function app.audit_structure_change('equipment_class', 'organization.manage');
create trigger audit_contractor after insert or update on contractor
  for each row execute function app.audit_structure_change('contractor', 'contractor.manage');
create trigger audit_contractor_site after insert or update on contractor_site
  for each row execute function app.audit_structure_change('contractor', 'contractor.manage');

revoke execute on function app.is_valid_timezone(text), app.check_timezone() from public;
grant execute on function app.is_valid_timezone(text) to app_authenticated, app_worker;

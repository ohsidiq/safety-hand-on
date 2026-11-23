-- 0011: Versi dan stempel waktu struktur organisasi untuk API-002 (M2.3)
-- Sumber: API-000 §10 (If-Match/version), API-002 §4-§9 (ORG-API-001..010), DB-001.
-- Data sintetis saja (B-24).

-- ---------------------------------------------------------------- 1. version + updated_at
-- PATCH dan aksi transisi memakai If-Match: <version>. Versi dinaikkan pemicu, bukan oleh klien.
alter table organization    add column version integer not null default 1, add column updated_at timestamptz not null default now();
alter table site            add column version integer not null default 1, add column updated_at timestamptz not null default now();
alter table department      add column version integer not null default 1, add column updated_at timestamptz not null default now();
alter table division        add column version integer not null default 1, add column updated_at timestamptz not null default now();
alter table team            add column version integer not null default 1, add column updated_at timestamptz not null default now();
alter table job_position    add column version integer not null default 1, add column updated_at timestamptz not null default now();
alter table equipment_class add column version integer not null default 1, add column updated_at timestamptz not null default now();

create function app.bump_version() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if to_jsonb(new) - 'version' - 'updated_at' is distinct from to_jsonb(old) - 'version' - 'updated_at' then
    new.version := old.version + 1;
    new.updated_at := now();
  else
    new.version := old.version;
    new.updated_at := old.updated_at;
  end if;
  return new;
end $$;
revoke execute on function app.bump_version() from public;

create trigger organization_version    before update on organization    for each row execute function app.bump_version();
create trigger site_version            before update on site            for each row execute function app.bump_version();
create trigger department_version      before update on department      for each row execute function app.bump_version();
create trigger division_version        before update on division        for each row execute function app.bump_version();
create trigger team_version            before update on team            for each row execute function app.bump_version();
create trigger job_position_version    before update on job_position    for each row execute function app.bump_version();
create trigger equipment_class_version before update on equipment_class for each row execute function app.bump_version();

-- ---------------------------------------------------------------- 2. audit tanpa kolom teknis
-- version dan updated_at bukan perubahan bisnis: tidak dicatat sebagai field yang berubah (AUD-003).
create or replace function app.audit_structure_change() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_entity text := tg_argv[0];
  v_perm text := tg_argv[1];
  v_new jsonb := to_jsonb(new) - 'version' - 'updated_at';
  v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) - 'version' - 'updated_at' end;
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

-- ---------------------------------------------------------------- 3. anggota team berada di Site team
-- Team milik satu Site (API-002 §4); scope Tim Supervisor (PB-008) tidak boleh menjangkau pekerja Site lain.
create function app.team_member_site() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from team t join worker w on w.id = new.worker_id
                 where t.id = new.team_id and w.site_id = t.site_id) then
    raise exception 'WORKER_SITE_MISMATCH: pekerja tidak ditempatkan di Site team' using errcode = '23514';
  end if;
  return new;
end $$;
revoke execute on function app.team_member_site() from public;
create trigger team_member_site before insert on team_member
  for each row execute function app.team_member_site();

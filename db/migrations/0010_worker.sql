-- 0010: Pekerja (M2.2)
-- Sumber: DB-001 v2.4 §8-§10 (ER-003..ER-014), SRS-WF002, API-003 §2-§4, B-18, B-23, PB-008 (scope Tim), PB-009.
-- Data sintetis saja (B-24). NIK hanya disimpan terenkripsi oleh Core API (ER-007); database tidak pernah
-- mengembalikannya ke peran aplikasi (hak kolom).

-- ---------------------------------------------------------------- 0. FK ke worker ikut berpindah Site
-- Tabel turunan menyimpan site_id (untuk RLS scope Site) dengan FK komposit ke worker. Mutasi Site lewat
-- penempatan harus ikut memperbarui baris turunan, bukan ditolak.
alter table competency_record drop constraint competency_record_worker_id_organization_id_site_id_fkey,
  add foreign key (worker_id, organization_id, site_id) references worker (id, organization_id, site_id) on update cascade;
alter table medical_status drop constraint medical_status_worker_id_organization_id_site_id_fkey,
  add foreign key (worker_id, organization_id, site_id) references worker (id, organization_id, site_id) on update cascade;
alter table medical_detail drop constraint medical_detail_worker_id_organization_id_site_id_fkey,
  add foreign key (worker_id, organization_id, site_id) references worker (id, organization_id, site_id) on update cascade;
alter table readiness_snapshot drop constraint readiness_snapshot_worker_id_organization_id_site_id_fkey,
  add foreign key (worker_id, organization_id, site_id) references worker (id, organization_id, site_id) on update cascade;

-- ---------------------------------------------------------------- 1. kolom worker (DB-001 §8)
alter table division add constraint division_id_department_uq unique (id, department_id);

alter table worker
  add column sho_id                text,
  add column employee_number       text,
  add column phone                 text,
  add column email                 text,
  add column national_id_encrypted bytea,
  add column national_id_hash      bytea,
  add column photo_file_id         uuid,
  add column contractor_id         uuid,
  add column worker_status         text not null default 'ACTIVE',
  add column join_date             date,
  add column exit_date             date,
  add column department_id         uuid,
  add column division_id           uuid,
  add column job_position_id       uuid,
  add column version               integer not null default 1,
  add column updated_at            timestamptz not null default now(),
  add column deleted_at            timestamptz;

-- Status kepegawaian baru (PERMANENT, CONTRACT, CONTRACTOR). Data M0: EMPLOYEE -> PERMANENT; CONTRACTOR dipertahankan
-- hanya bila ada kontraktor organisasi yang terhubung ke Site pekerja (ER-012/ER-013), selain itu CONTRACT.
alter table worker drop constraint worker_employment_status_check;
update worker set employment_status = 'PERMANENT' where employment_status = 'EMPLOYEE';
update worker w set contractor_id = (
  select cs.contractor_id from contractor_site cs join contractor c on c.id = cs.contractor_id and c.status = 'ACTIVE'
  where cs.organization_id = w.organization_id and cs.site_id = w.site_id and cs.valid_until is null
  order by c.code limit 1)
where w.employment_status = 'CONTRACTOR';
update worker set employment_status = 'CONTRACT' where employment_status = 'CONTRACTOR' and contractor_id is null;

-- Posisi teks M0 -> job_position (nama sama dalam organisasi); department -> Produksi di Site pekerja bila ada.
update worker w set job_position_id = jp.id
from job_position jp where jp.organization_id = w.organization_id and jp.name = w.job_position and jp.status = 'ACTIVE';
update worker w set department_id = (
  select d.id from department d where d.site_id = w.site_id and d.status = 'ACTIVE' order by (d.code = 'PROD') desc, d.code limit 1);
update worker set join_date = created_at::date where join_date is null;
alter table worker drop column job_position;

-- SHO ID: SHO-<kode organisasi>-<nomor urut 6 digit> (contoh API-003 §2), dibuat sistem, tidak berubah (ER-004).
create table worker_sho_counter (
  organization_id uuid primary key references organization (id),
  last_value      integer not null default 0
);
alter table worker_sho_counter enable row level security;
alter table worker_sho_counter force row level security;
revoke all on worker_sho_counter from public;
-- Hanya fungsi SECURITY DEFINER milik pemilik migrasi yang menulis penghitung; peran aplikasi tidak punya hak.
create policy worker_sho_counter_definer on worker_sho_counter for all to current_user using (true) with check (true);

create function app.next_sho_id(p_org uuid) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n integer;
  v_code text;
begin
  insert into worker_sho_counter (organization_id, last_value) values (p_org, 1)
  on conflict (organization_id) do update set last_value = worker_sho_counter.last_value + 1
  returning last_value into v_n;
  select coalesce(code, 'ORG') into v_code from organization where id = p_org;
  return 'SHO-' || v_code || '-' || lpad(v_n::text, 6, '0');
end $$;
revoke execute on function app.next_sho_id(uuid) from public;

update worker w set sho_id = x.sho, employee_number = x.emp
from (select id, app.next_sho_id(organization_id) as sho,
             'EMP-' || lpad(row_number() over (partition by organization_id order by created_at, id)::text, 6, '0') as emp
      from (select * from worker order by organization_id, created_at, id) o) x
where x.id = w.id;

alter table worker
  alter column sho_id set not null,
  alter column employee_number set not null,
  alter column join_date set not null,
  add constraint worker_employment_status_chk check (employment_status in ('PERMANENT', 'CONTRACT', 'CONTRACTOR')),
  add constraint worker_status_chk check (worker_status in ('ACTIVE', 'INACTIVE', 'SUSPENDED', 'RESIGNED')),
  add constraint worker_contractor_er012 check ((employment_status = 'CONTRACTOR') = (contractor_id is not null)),
  add constraint worker_exit_chk check (exit_date is null or exit_date >= join_date),
  add constraint worker_name_chk check (length(btrim(full_name)) between 2 and 150),
  add constraint worker_employee_number_chk check (employee_number ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$'),
  add constraint worker_resigned_exit_chk check (worker_status <> 'RESIGNED' or exit_date is not null),
  add constraint worker_nik_pair_chk check ((national_id_encrypted is null) = (national_id_hash is null)),
  add constraint worker_sho_uq unique (organization_id, sho_id),
  add foreign key (department_id, site_id) references department (id, site_id),
  add foreign key (division_id, department_id) references division (id, department_id),
  add foreign key (job_position_id, organization_id) references job_position (id, organization_id),
  add foreign key (contractor_id, organization_id) references contractor (id, organization_id);
create unique index worker_employee_number_uq on worker (organization_id, employee_number) where deleted_at is null;
create unique index worker_nik_hash_uq on worker (organization_id, national_id_hash)
  where national_id_hash is not null and deleted_at is null;
create index worker_org_status_idx on worker (organization_id, worker_status);
create index worker_contractor_idx on worker (contractor_id) where contractor_id is not null;

-- SHO ID dibuat saat insert dan tidak dapat diubah
create function app.worker_sho() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.sho_id := app.next_sho_id(new.organization_id);
  elsif new.sho_id is distinct from old.sho_id then
    raise exception 'SHO_ID_IMMUTABLE: SHO ID tidak dapat diubah' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger worker_sho before insert or update of sho_id on worker
  for each row execute function app.worker_sho();

-- ER-013: pekerja kontraktor yang memiliki contractor_site berlaku hanya pada Site yang terhubung
create function app.worker_contractor_site() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.contractor_id is not null
     and exists (select 1 from contractor_site cs where cs.contractor_id = new.contractor_id and cs.valid_until is null)
     and not exists (select 1 from contractor_site cs where cs.contractor_id = new.contractor_id
                     and cs.site_id = new.site_id and cs.valid_until is null) then
    raise exception 'CONTRACTOR_SITE_NOT_LINKED: kontraktor tidak terhubung ke Site penempatan' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger worker_contractor_site before insert or update of site_id, contractor_id on worker
  for each row execute function app.worker_contractor_site();

-- ER-008: menonaktifkan atau resign pekerja menonaktifkan akun terkait (Worker tidak dihapus)
create function app.worker_deactivate_account() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.user_id is not null and new.worker_status in ('INACTIVE', 'RESIGNED')
     and old.worker_status not in ('INACTIVE', 'RESIGNED') then
    update user_profile set status = 'DEACTIVATED' where id = new.user_id and status <> 'DEACTIVATED';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger worker_deactivate_account before update on worker
  for each row execute function app.worker_deactivate_account();

-- ---------------------------------------------------------------- 2. worker_assignment (riwayat penempatan, DB-001 §9)
create table worker_assignment (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  worker_id       uuid not null,
  site_id         uuid not null,
  department_id   uuid,
  division_id     uuid,
  job_position_id uuid,
  effective_from  date not null,
  effective_until date,
  reason          text not null default 'INITIAL',
  created_at      timestamptz not null default now(),
  foreign key (worker_id, organization_id) references worker (id, organization_id),
  foreign key (site_id, organization_id) references site (id, organization_id),
  foreign key (department_id, site_id) references department (id, site_id),
  foreign key (division_id, department_id) references division (id, department_id),
  foreign key (job_position_id, organization_id) references job_position (id, organization_id),
  constraint worker_assignment_range_chk check (effective_until is null or effective_until >= effective_from),
  constraint worker_assignment_no_overlap exclude using gist (
    worker_id with =, daterange(effective_from, effective_until, '[]') with &&)
);
create unique index worker_assignment_current_uq on worker_assignment (worker_id) where effective_until is null;
create index worker_assignment_org_site_idx on worker_assignment (organization_id, site_id);

insert into worker_assignment (organization_id, worker_id, site_id, department_id, division_id, job_position_id, effective_from, reason)
select organization_id, id, site_id, department_id, division_id, job_position_id, join_date, 'INITIAL' from worker;

-- Penempatan baru menutup penempatan berjalan (sehari sebelum tanggal berlaku) lalu memperbarui proyeksi worker
-- dalam transaksi yang sama (DB-001 §8: kolom penempatan worker adalah proyeksi).
create function app.worker_assignment_before() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.effective_until is null then
    update worker_assignment set effective_until = new.effective_from - 1
    where worker_id = new.worker_id and effective_until is null and id <> new.id;
  end if;
  return new;
end $$;
create trigger worker_assignment_before before insert on worker_assignment
  for each row execute function app.worker_assignment_before();

create function app.worker_assignment_after() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.effective_until is null then
    update worker set site_id = new.site_id, department_id = new.department_id, division_id = new.division_id,
                      job_position_id = new.job_position_id, version = version + 1
    where id = new.worker_id
      and (site_id, department_id, division_id, job_position_id)
          is distinct from (new.site_id, new.department_id, new.division_id, new.job_position_id);
  end if;
  return null;
end $$;
create trigger worker_assignment_after after insert on worker_assignment
  for each row execute function app.worker_assignment_after();

-- Pekerja baru otomatis memperoleh penempatan awal dari kolom penempatannya
create function app.worker_initial_assignment() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into worker_assignment (organization_id, worker_id, site_id, department_id, division_id, job_position_id, effective_from, reason)
  values (new.organization_id, new.id, new.site_id, new.department_id, new.division_id, new.job_position_id, new.join_date, 'INITIAL');
  return null;
end $$;
create trigger worker_initial_assignment after insert on worker
  for each row execute function app.worker_initial_assignment();

-- ---------------------------------------------------------------- 3. struktur dengan pekerja aktif tidak dapat dinonaktifkan
-- ORG-API-004, BR-WF001-009 (ditunda dari M2.1 sampai status pekerja dan penempatan ada)
create function app.block_deactivate_in_use() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_in_use boolean;
begin
  if not (new.status = 'INACTIVE' and old.status = 'ACTIVE') then
    return new;
  end if;
  v_in_use := case tg_table_name
    when 'site' then exists (select 1 from worker w where w.site_id = new.id and w.worker_status in ('ACTIVE', 'SUSPENDED') and w.deleted_at is null)
    when 'department' then exists (select 1 from worker w where w.department_id = new.id and w.worker_status in ('ACTIVE', 'SUSPENDED') and w.deleted_at is null)
    when 'job_position' then exists (select 1 from worker w where w.job_position_id = new.id and w.worker_status in ('ACTIVE', 'SUSPENDED') and w.deleted_at is null)
    when 'team' then exists (select 1 from team_member tm join worker w on w.id = tm.worker_id
                             where tm.team_id = new.id and (tm.valid_until is null or tm.valid_until >= current_date)
                               and w.worker_status in ('ACTIVE', 'SUSPENDED') and w.deleted_at is null)
    else false end;
  if v_in_use then
    raise exception 'ACTIVE_WORKERS_EXIST: % masih memiliki pekerja aktif', tg_table_name using errcode = '23514';
  end if;
  return new;
end $$;
create trigger site_block_deactivate before update of status on site for each row execute function app.block_deactivate_in_use();
create trigger department_block_deactivate before update of status on department for each row execute function app.block_deactivate_in_use();
create trigger job_position_block_deactivate before update of status on job_position for each row execute function app.block_deactivate_in_use();
create trigger team_block_deactivate before update of status on team for each row execute function app.block_deactivate_in_use();

-- ---------------------------------------------------------------- 4. scope Tim (PB-008) dan validasi referensi scope
-- Pekerja anggota aktif dari team pada penugasan berscope TEAM dengan level FULL/TEAM untuk permission ini.
create function app.permitted_team_workers(perm text) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct tm.worker_id), '{}'::uuid[])
  from user_role_assignment ura
  join role_permission rp on rp.role_code = ura.role_code
  join user_profile up on up.id = ura.user_id and up.status = 'ACTIVE'
  join team_member tm on tm.team_id = ura.scope_id
    and tm.valid_from <= current_date and (tm.valid_until is null or tm.valid_until >= current_date)
  where ura.user_id = app.current_user_id()
    and ura.scope_type = 'TEAM'
    and ura.revoked_at is null and ura.valid_from <= now() and (ura.valid_until is null or ura.valid_until > now())
    and rp.permission_code = perm and rp.constraint_level in ('FULL', 'TEAM')
$$;
revoke execute on function app.permitted_team_workers(text) from public;
grant execute on function app.permitted_team_workers(text) to app_authenticated;

drop policy worker_read on worker;
create policy worker_read on worker for select to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('worker.read'))
              or site_id = any ((select app.permitted_sites('worker.read'))::uuid[])
              or id = any ((select app.permitted_team_workers('worker.read'))::uuid[])));

-- Scope DEPARTMENT/TEAM harus menunjuk objek organisasi yang sama (melengkapi validasi SITE pada 0005)
create function app.ura_validate_scope_ref() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.scope_type = 'TEAM' and not exists (select 1 from team t where t.id = new.scope_id and t.organization_id = new.organization_id) then
    raise exception 'SCOPE_INVALID: team bukan milik organisasi' using errcode = '23503';
  end if;
  if new.scope_type = 'DEPARTMENT' and not exists (select 1 from department d where d.id = new.scope_id and d.organization_id = new.organization_id) then
    raise exception 'SCOPE_INVALID: department bukan milik organisasi' using errcode = '23503';
  end if;
  if new.scope_type = 'CONTRACTOR' and not exists (select 1 from contractor c where c.id = new.scope_id and c.organization_id = new.organization_id) then
    raise exception 'SCOPE_INVALID: kontraktor bukan milik organisasi' using errcode = '23503';
  end if;
  return new;
end $$;
create trigger ura_validate_scope_ref before insert or update of scope_type, scope_id on user_role_assignment
  for each row execute function app.ura_validate_scope_ref();

-- ---------------------------------------------------------------- 5. hak kolom worker dan RLS penempatan
-- NIK (terenkripsi dan HMAC) tidak dapat dibaca peran aplikasi sama sekali (ER-007, API-003 §2).
revoke select, insert, update on worker from app_authenticated;
grant select (id, organization_id, site_id, full_name, employment_status, created_at, user_id, sho_id, employee_number,
              phone, email, photo_file_id, contractor_id, worker_status, join_date, exit_date, department_id, division_id,
              job_position_id, version, updated_at, deleted_at) on worker to app_authenticated;
grant insert (organization_id, site_id, full_name, employment_status, employee_number, phone, email, national_id_encrypted,
              national_id_hash, photo_file_id, contractor_id, join_date, department_id, division_id, job_position_id)
  on worker to app_authenticated;
-- Penempatan (Site, Department, Division, Posisi) hanya lewat worker_assignment (API-003 §2), bukan UPDATE langsung.
grant update (full_name, employment_status, phone, email, national_id_encrypted, national_id_hash, photo_file_id,
              contractor_id, worker_status, exit_date, version, user_id) on worker to app_authenticated;

alter table worker_assignment enable row level security;
alter table worker_assignment force row level security;
revoke all on worker_assignment from public;
grant select, insert on worker_assignment to app_authenticated;
create policy worker_assignment_read on worker_assignment for select to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('worker.read'))
              or site_id = any ((select app.permitted_sites('worker.read'))::uuid[])
              or worker_id = any ((select app.permitted_team_workers('worker.read'))::uuid[])));
create policy worker_assignment_insert on worker_assignment for insert to app_authenticated
  with check (organization_id = (select app.current_org())
              and ((select app.has_org_wide('worker.update')) or site_id = any ((select app.permitted_sites('worker.update'))::uuid[])));

-- ---------------------------------------------------------------- 6. audit perubahan pekerja (WF-API audit, ER-014)
-- NIK hanya sebagai nama field; nilai lama/baru tidak dicatat (AUD-003).
create function app.audit_worker_change() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_new jsonb := to_jsonb(new) - 'national_id_encrypted' - 'national_id_hash' - 'updated_at' - 'version';
  v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) - 'national_id_encrypted' - 'national_id_hash' - 'updated_at' - 'version' end;
  v_fields text[];
  v_changes jsonb;
  v_action text;
  v_entity text := case tg_table_name when 'worker_assignment' then 'worker_assignment' else 'worker' end;
begin
  if tg_table_name = 'worker_assignment' then
    if new.reason = 'INITIAL' then
      return null; -- penempatan awal sudah tercakup worker.create
    end if;
    perform app.audit_enqueue(new.organization_id, 'worker.assign', 'worker', new.worker_id,
      array['site_id', 'department_id', 'division_id', 'job_position_id', 'effective_from', 'reason'],
      jsonb_build_object('site_id', new.site_id, 'department_id', new.department_id, 'division_id', new.division_id,
                         'job_position_id', new.job_position_id, 'effective_from', new.effective_from, 'reason', new.reason),
      'worker.update', new.site_id);
    return null;
  end if;
  if tg_op = 'INSERT' then
    select array_agg(k order by k) into v_fields from jsonb_object_keys(v_new) k where k not in ('id', 'organization_id', 'created_at');
    if new.national_id_hash is not null then v_fields := array_append(v_fields, 'national_id'); end if;
    perform app.audit_enqueue(new.organization_id, 'worker.create', 'worker', new.id, v_fields,
      v_new - 'id' - 'organization_id' - 'created_at', 'worker.create', new.site_id);
    return null;
  end if;
  select array_agg(k order by k), jsonb_object_agg(k, jsonb_build_object('from', v_old->k, 'to', v_new->k))
  into v_fields, v_changes
  from jsonb_object_keys(v_new) k where v_new->k is distinct from v_old->k;
  if new.national_id_hash is distinct from old.national_id_hash then
    v_fields := array_append(coalesce(v_fields, '{}'::text[]), 'national_id');
  end if;
  if v_fields is null then
    return null;
  end if;
  v_action := case
    when new.worker_status is distinct from old.worker_status then
      case new.worker_status when 'SUSPENDED' then 'worker.suspend' when 'INACTIVE' then 'worker.deactivate'
        when 'RESIGNED' then 'worker.resign' else case old.worker_status when 'SUSPENDED' then 'worker.reinstate' else 'worker.reactivate' end end
    else 'worker.update' end;
  perform app.audit_enqueue(new.organization_id, v_action, 'worker', new.id, v_fields, v_changes,
    case when v_action in ('worker.deactivate', 'worker.reactivate') then 'worker.deactivate' else 'worker.update' end, new.site_id);
  return null;
end $$;
create trigger audit_worker after insert or update on worker for each row execute function app.audit_worker_change();
create trigger audit_worker_assignment after insert on worker_assignment for each row execute function app.audit_worker_change();

revoke execute on function app.worker_sho(), app.worker_contractor_site(), app.worker_deactivate_account(),
  app.worker_assignment_before(), app.worker_assignment_after(), app.worker_initial_assignment(),
  app.block_deactivate_in_use(), app.ura_validate_scope_ref(), app.audit_worker_change() from public;

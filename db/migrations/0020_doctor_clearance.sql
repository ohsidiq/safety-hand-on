-- 0020_doctor_clearance.sql: peran Dokter dan pemeriksaan kesiapan kerja khusus (B-27, keputusan pemilik 2026-11-27).
-- 1. Role DOCTOR (Dokter): menetapkan Fit to Work dan menerbitkan pemeriksaan kesiapan kerja khusus (pra-tugas).
--    Medical Officer menjadi petugas medis/paramedis: mencatat MCU, membaca detail, TIDAK menetapkan (medical.verify dicabut).
--    Permission baru medical.clearance (PB-009 v3.6: 57 permission).
-- 2. Fit to Work: FIT, FIT_WITH_CONDITION (tindak lanjut ringan: catatan non-diagnostik + tanggal, wajib),
--    FIT_WITH_RESTRICTION (pembatasan kerja), UNFIT (tanggal tinjau ulang opsional). TEMPORARILY_UNFIT dihapus: data lama
--    diubah menjadi UNFIT dengan tanggal tinjau ulang = unfit_until.
-- 3. medical_clearance: hasil SIAP/TIDAK SIAP untuk jenis kerja khusus (mis. ketinggian), berlaku satu shift (bawaan 12 jam,
--    1..24 per jenis). Checklist wajib (riwayat penyakit ditinjau, tensi dan tanda vital diukur, dalam batas aman).
--    ANGKA TANDA VITAL TIDAK DISIMPAN (tetap di rekam medis klinik). SIAP ditolak bila MCU terakhir tidak berlaku/UNFIT
--    atau ada pembatasan aktif yang bertentangan dengan jenis kerja.

-- ---------------------------------------------------------------- 1. role dan permission
insert into role(code, name, scope_levels, phase, is_active)
values ('DOCTOR', 'Dokter', array['ORGANIZATION', 'SITE']::text[], 'P1', true);
insert into permission(code, module, action, domain, description, is_sensitive)
values ('medical.clearance', 'medical', 'clearance', 'Readiness',
        'Menerbitkan pemeriksaan kesiapan kerja khusus (pra-tugas)', false);
-- Dokter mewarisi akses Medical Officer, ditambah penetapan dan pemeriksaan kesiapan
insert into role_permission(role_code, permission_code, constraint_level)
select 'DOCTOR', permission_code, constraint_level from role_permission where role_code = 'MEDICAL_OFFICER';
insert into role_permission(role_code, permission_code, constraint_level) values ('DOCTOR', 'medical.clearance', 'FULL');
delete from role_permission where role_code = 'MEDICAL_OFFICER' and permission_code = 'medical.verify';

-- ---------------------------------------------------------------- 2. Fit to Work empat hasil + tindak lanjut
alter table medical_record add column follow_up_note text check (length(follow_up_note) <= 300),
                           add column follow_up_due date;
update medical_record set fitness_status = 'UNFIT' where fitness_status = 'TEMPORARILY_UNFIT';
alter table medical_record drop constraint medical_record_fitness_status_check;
alter table medical_record add constraint medical_record_fitness_status_check
  check (fitness_status in ('FIT', 'FIT_WITH_CONDITION', 'FIT_WITH_RESTRICTION', 'UNFIT'));
alter table medical_record drop constraint medical_record_unfit_until_chk;
-- unfit_until = tanggal tinjau ulang, hanya untuk UNFIT (opsional)
alter table medical_record add constraint medical_record_unfit_until_chk
  check (unfit_until is null or fitness_status = 'UNFIT');
alter table medical_record add constraint medical_record_follow_up_chk
  check ((fitness_status = 'FIT_WITH_CONDITION')
         = (length(btrim(coalesce(follow_up_note, ''))) > 0 and follow_up_due is not null));
grant update (follow_up_note, follow_up_due) on medical_record to app_authenticated;

create or replace function app.medical_record_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.file_id is not null and (tg_op = 'INSERT' or new.file_id is distinct from old.file_id) and not exists (
       select 1 from file_object f where f.id = new.file_id and f.organization_id = new.organization_id
         and f.scan_status = 'CLEAN' and f.purpose = 'MEDICAL_DOCUMENT' and f.deleted_at is null
         and (app.current_user_id() is null or f.uploaded_by = app.current_user_id())) then
    raise exception 'FILE_NOT_CLEAN: berkas belum lolos pemeriksaan atau bukan dokumen medis' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    return new;
  end if;
  if (new.exam_type_id, new.examination_date, new.expiry_date, new.provider, new.file_id)
     is distinct from (old.exam_type_id, old.examination_date, old.expiry_date, old.provider, old.file_id)
     and new.verification_status = old.verification_status and old.verification_status <> 'PENDING' then
    new.verification_status := 'PENDING';
    new.fitness_status := null;
    new.unfit_until := null;
    new.follow_up_note := null;
    new.follow_up_due := null;
    new.verified_by := null;
    new.verified_at := null;
    new.determination_comment := null;
    new.rejection_reason := null;
    -- pengakhiran otomatis oleh sistem: pencatat (Medical Officer) tidak memegang medical.verify
    perform set_config('app.medical_auto_lift', 'on', true);
    update medical_restriction set status = 'LIFTED', lift_reason = 'Record medis diajukan ulang', lifted_at = now()
     where medical_record_id = new.id and status = 'ACTIVE';
    perform set_config('app.medical_auto_lift', 'off', true);
  end if;
  if new.verification_status <> old.verification_status and new.verification_status <> 'PENDING' then
    if old.verification_status <> 'PENDING' then
      raise exception 'INVALID_STATE_TRANSITION: penetapan hanya dari PENDING' using errcode = '23514';
    end if;
    if app.current_user_id() is not null
       and (not app.has_permission('medical.verify', new.site_id) or new.verified_by is distinct from app.current_user_id()) then
      raise exception 'penetapan Fit to Work hanya oleh Dokter' using errcode = '42501';
    end if;
  elsif new.verification_status = old.verification_status
        and (new.fitness_status, new.unfit_until, new.follow_up_note, new.follow_up_due)
            is distinct from (old.fitness_status, old.unfit_until, old.follow_up_note, old.follow_up_due) then
    raise exception 'INVALID_STATE_TRANSITION: Fit to Work hanya berubah lewat penetapan' using errcode = '23514';
  end if;
  return new;
end $$;

create or replace function app.medical_restriction_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_site uuid;
  v_fitness text;
  v_auto boolean := tg_op = 'UPDATE' and coalesce(current_setting('app.medical_auto_lift', true), 'off') = 'on'
                    and new.status = 'LIFTED' and new.lifted_by is null;
begin
  select site_id, fitness_status into v_site, v_fitness from medical_record where id = new.medical_record_id;
  if app.current_user_id() is not null and not v_auto and not app.has_permission('medical.verify', v_site) then
    raise exception 'pembatasan medis hanya oleh Dokter' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and v_fitness is distinct from 'FIT_WITH_RESTRICTION' then
    raise exception 'RESTRICTION_NOT_ALLOWED: pembatasan hanya untuk FIT_WITH_RESTRICTION' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    if old.status = 'LIFTED' then
      raise exception 'INVALID_STATE_TRANSITION: pembatasan sudah diakhiri' using errcode = '23514';
    end if;
    if (new.restriction_code, new.operational_description, new.valid_from, new.valid_until)
       is distinct from (old.restriction_code, old.operational_description, old.valid_from, old.valid_until) then
      raise exception 'INVALID_STATE_TRANSITION: pembatasan diubah lewat penetapan baru' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

-- tingkat status: menambah tanggal tindak lanjut (tanpa catatan) dan pemeriksaan kesiapan aktif
drop function app.medical_status(uuid);
create function app.medical_status(p_worker uuid)
returns table (worker_id uuid, fitness_status text, validity_status text, expiry_date date, unfit_until date,
               follow_up_due date, restrictions jsonb, has_pending boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  with w as (
    select w.id, w.site_id from worker w
    where w.id = p_worker and w.organization_id = app.current_org()
      and (app.has_org_wide('medical.read_status')
           or w.site_id = any (app.permitted_sites('medical.read_status'))
           or w.id = any (app.permitted_team_workers('medical.read_status'))
           or (w.id = app.my_worker_id() and app.has_self_permission('medical.read_status')))
  ), latest as (
    select m.* from medical_record m join w on w.id = m.worker_id
    where m.verification_status = 'VERIFIED'
    order by m.examination_date desc, m.verified_at desc limit 1
  )
  select w.id,
         l.fitness_status,
         case
           when l.id is null and exists (select 1 from medical_record p where p.worker_id = w.id and p.verification_status = 'PENDING')
             then 'PENDING_VERIFICATION'
           when l.id is null then 'MISSING'
           when l.fitness_status = 'UNFIT' then 'SUSPENDED'
           when l.expiry_date < app.site_today(w.site_id) then 'EXPIRED'
           when l.expiry_date <= app.site_today(w.site_id) + 30 then 'EXPIRING_SOON'
           else 'VALID' end,
         l.expiry_date,
         l.unfit_until,
         l.follow_up_due,
         coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'restriction_code', r.restriction_code,
                                                       'operational_description', r.operational_description,
                                                       'valid_from', r.valid_from, 'valid_until', r.valid_until)
                                    order by r.valid_from)
                   from medical_restriction r
                   where r.medical_record_id = l.id and r.status = 'ACTIVE'
                     and (r.valid_until is null or r.valid_until >= app.site_today(w.site_id))), '[]'::jsonb),
         exists (select 1 from medical_record p where p.worker_id = w.id and p.verification_status = 'PENDING')
  from w left join latest l on true
$$;
revoke execute on function app.medical_status(uuid) from public;
grant execute on function app.medical_status(uuid) to app_authenticated;

-- ---------------------------------------------------------------- 3. jenis kerja khusus
create table medical_clearance_type (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references organization (id),
  name                     text not null check (length(btrim(name)) between 2 and 150),
  code                     app.code_text not null,
  description              text check (length(description) <= 1000),
  validity_hours           integer not null default 12 check (validity_hours between 1 and 24),
  -- pembatasan operasional yang menghalangi SIAP (mis. Kerja di Ketinggian <- NO_WORK_AT_HEIGHT)
  blocking_restriction_codes text[] not null default '{}'::text[],
  status                   text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  version                  integer not null default 1,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint medical_clearance_type_org_uq unique (id, organization_id)
);
create unique index medical_clearance_type_code_uq on medical_clearance_type (organization_id, code) where status = 'ACTIVE';
alter table medical_clearance_type enable row level security;
alter table medical_clearance_type force row level security;
revoke all on medical_clearance_type from public;
grant select, insert, update on medical_clearance_type to app_authenticated;
create policy medical_clearance_type_read on medical_clearance_type for select to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_any_scope('organization.read')) or (select app.has_any_scope('medical.clearance'))));
create policy medical_clearance_type_insert on medical_clearance_type for insert to app_authenticated
  with check (organization_id = (select app.current_org()) and (select app.has_org_wide('readiness_profile.manage')));
create policy medical_clearance_type_update on medical_clearance_type for update to app_authenticated
  using (organization_id = (select app.current_org()) and (select app.has_org_wide('readiness_profile.manage')))
  with check (organization_id = (select app.current_org()));
create trigger medical_clearance_type_version before update on medical_clearance_type
  for each row execute function app.bump_version();
create trigger audit_medical_clearance_type after insert or update on medical_clearance_type
  for each row execute function app.audit_structure_change('medical_clearance_type', 'readiness_profile.manage');

-- ---------------------------------------------------------------- 4. pemeriksaan kesiapan kerja khusus
create table medical_clearance (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null,
  site_id               uuid not null,
  worker_id             uuid not null,
  clearance_type_id     uuid not null,
  result                text not null check (result in ('CLEARED', 'NOT_CLEARED')),
  history_reviewed      boolean not null,
  blood_pressure_checked boolean not null,
  vital_signs_checked   boolean not null,
  vitals_within_limits  boolean not null,
  -- alasan TIDAK SIAP berupa batasan kerja/tindak lanjut, bukan diagnosis
  note                  text check (length(note) <= 300),
  examined_by           uuid not null references user_profile (id),
  examined_at           timestamptz not null default now(),
  valid_until           timestamptz,
  revoked_at            timestamptz,
  revoked_by            uuid references user_profile (id),
  revoke_reason         text check (length(revoke_reason) <= 300),
  created_at            timestamptz not null default now(),
  foreign key (worker_id, organization_id, site_id) references worker (id, organization_id, site_id) on update cascade,
  foreign key (clearance_type_id, organization_id) references medical_clearance_type (id, organization_id),
  -- SIAP hanya bila seluruh checklist terpenuhi dan bermasa berlaku
  constraint medical_clearance_cleared_chk check (result <> 'CLEARED'
    or (history_reviewed and blood_pressure_checked and vital_signs_checked and vitals_within_limits
        and valid_until is not null and valid_until > examined_at and valid_until <= examined_at + interval '24 hours')),
  constraint medical_clearance_not_cleared_chk check (result <> 'NOT_CLEARED'
    or (valid_until is null and length(btrim(coalesce(note, ''))) > 0)),
  constraint medical_clearance_revoke_chk check (revoked_at is null
    or (revoked_by is not null and length(btrim(coalesce(revoke_reason, ''))) > 0))
);
create index medical_clearance_worker_idx on medical_clearance (worker_id, examined_at desc);

create function app.medical_clearance_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  st record;
  t medical_clearance_type%rowtype;
begin
  if tg_op = 'UPDATE' then
    if old.revoked_at is not null then
      raise exception 'INVALID_STATE_TRANSITION: pemeriksaan kesiapan sudah dicabut' using errcode = '23514';
    end if;
    if (new.result, new.history_reviewed, new.blood_pressure_checked, new.vital_signs_checked, new.vitals_within_limits,
        new.note, new.examined_by, new.examined_at, new.valid_until, new.clearance_type_id, new.worker_id)
       is distinct from (old.result, old.history_reviewed, old.blood_pressure_checked, old.vital_signs_checked,
                         old.vitals_within_limits, old.note, old.examined_by, old.examined_at, old.valid_until,
                         old.clearance_type_id, old.worker_id) then
      raise exception 'INVALID_STATE_TRANSITION: hasil pemeriksaan tidak dapat diubah, cabut lalu periksa ulang' using errcode = '23514';
    end if;
    if app.current_user_id() is not null
       and (not app.has_permission('medical.clearance', new.site_id) or new.revoked_by is distinct from app.current_user_id()) then
      raise exception 'pencabutan hanya oleh Dokter' using errcode = '42501';
    end if;
    return new;
  end if;
  if app.current_user_id() is not null
     and (not app.has_permission('medical.clearance', new.site_id) or new.examined_by is distinct from app.current_user_id()) then
    raise exception 'pemeriksaan kesiapan hanya oleh Dokter' using errcode = '42501';
  end if;
  select * into t from medical_clearance_type where id = new.clearance_type_id;
  if new.result = 'CLEARED' then
    -- MCU terakhir harus berlaku dan tidak UNFIT; pembatasan aktif tidak boleh bertentangan dengan jenis kerja
    select m.id, m.fitness_status, m.expiry_date into st from medical_record m
     where m.worker_id = new.worker_id and m.verification_status = 'VERIFIED'
     order by m.examination_date desc, m.verified_at desc limit 1;
    if st.id is null or st.fitness_status = 'UNFIT' or st.expiry_date < app.site_today(new.site_id) then
      raise exception 'MCU_NOT_VALID: MCU terakhir tidak berlaku atau Unfit' using errcode = '23514';
    end if;
    if exists (select 1 from medical_restriction r where r.medical_record_id = st.id and r.status = 'ACTIVE'
                 and (r.valid_until is null or r.valid_until >= app.site_today(new.site_id))
                 and r.restriction_code = any (t.blocking_restriction_codes)) then
      raise exception 'RESTRICTION_CONFLICT: pembatasan aktif bertentangan dengan jenis kerja ini' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
revoke execute on function app.medical_clearance_guard() from public;
create trigger medical_clearance_guard before insert or update on medical_clearance
  for each row execute function app.medical_clearance_guard();

alter table medical_clearance enable row level security;
alter table medical_clearance force row level security;
revoke all on medical_clearance from public;
grant select, insert on medical_clearance to app_authenticated;
grant update (revoked_at, revoked_by, revoke_reason) on medical_clearance to app_authenticated;
-- tingkat detail (checklist, catatan): Dokter/petugas medis (medical.read_detail), pekerja sendiri
create policy medical_clearance_read on medical_clearance for select to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('medical.read_detail'))
              or site_id = any ((select app.permitted_sites('medical.read_detail'))::uuid[])
              or (worker_id = (select app.my_worker_id()) and (select app.has_self_permission('medical.read_detail')))));
create policy medical_clearance_insert on medical_clearance for insert to app_authenticated
  with check (organization_id = (select app.current_org()) and examined_by = (select app.current_user_id())
              and revoked_at is null
              and ((select app.has_org_wide('medical.clearance'))
                   or site_id = any ((select app.permitted_sites('medical.clearance'))::uuid[])));
create policy medical_clearance_update on medical_clearance for update to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('medical.clearance'))
              or site_id = any ((select app.permitted_sites('medical.clearance'))::uuid[])))
  with check (organization_id = (select app.current_org()));

-- tingkat status: jenis, hasil, berlaku sampai (tanpa checklist/catatan) untuk pemegang medical.read_status
create function app.medical_clearance_status(p_worker uuid)
returns table (id uuid, clearance_type_id uuid, type_name text, type_code text, result text, examined_at timestamptz,
               valid_until timestamptz, active boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select c.id, c.clearance_type_id, t.name, t.code, c.result, c.examined_at, c.valid_until,
         (c.result = 'CLEARED' and c.revoked_at is null and c.valid_until > now()) as active
  from medical_clearance c
  join medical_clearance_type t on t.id = c.clearance_type_id
  join worker w on w.id = c.worker_id
  where c.worker_id = p_worker and w.organization_id = app.current_org() and c.revoked_at is null
    and c.examined_at > now() - interval '7 days'
    and (app.has_org_wide('medical.read_status')
         or w.site_id = any (app.permitted_sites('medical.read_status'))
         or w.id = any (app.permitted_team_workers('medical.read_status'))
         or (w.id = app.my_worker_id() and app.has_self_permission('medical.read_status')))
  order by c.examined_at desc
$$;
revoke execute on function app.medical_clearance_status(uuid) from public;
grant execute on function app.medical_clearance_status(uuid) to app_authenticated;

create function app.audit_medical_clearance() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- tanpa checklist dan catatan di payload (sensitif); hanya aksi dan hasil
  perform app.audit_enqueue(new.organization_id,
    case when tg_op = 'INSERT' then 'medical.clearance_issue' else 'medical.clearance_revoke' end,
    'medical_clearance', new.id, array['result', 'valid_until'],
    jsonb_build_object('result', new.result, 'clearance_type_id', new.clearance_type_id, 'worker_id', new.worker_id),
    'medical.clearance', new.site_id, 'SUCCESS', true);
  return null;
end $$;
revoke execute on function app.audit_medical_clearance() from public;
create trigger audit_medical_clearance after insert or update of revoked_at on medical_clearance
  for each row execute function app.audit_medical_clearance();

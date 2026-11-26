-- 0019_medical.sql: Medical (WF004, API-005, DB-003 §4, DB-008). Data Sensitif; hanya data sintetis (B-24).
-- Prinsip:
-- - Diagnosis dan hasil laboratorium TIDAK disimpan. Hanya jenis pemeriksaan, tanggal, Fit to Work, masa berlaku,
--   pembatasan operasional, dan dokumen di bucket terbatas (soh-medical).
-- - Tingkat detail (tabel medical_record, dokumen): Medical Officer (medical.read_detail penuh), pekerja sendiri (SELF),
--   HSE Manager hanya dengan medical_access_grant aktif (berbatas <= 24 jam). Pencatat administratif melihat record
--   buatannya selama belum ditetapkan.
-- - Tingkat status: fungsi app.medical_status (security definer) untuk pemegang medical.read_status sesuai scope
--   (Site, Tim, diri sendiri). Tanpa file, penyedia, jenis pemeriksaan, komentar.
-- - Pencatatan administratif: medical.update penuh ATAU LIMITED (HSE Officer, Site Admin). LIMITED di sini berarti
--   "data administratif saja": penetapan Fit to Work tetap hanya medical.verify (Medical Officer).
-- - Penetapan oleh bukan pembuat (pemisahan tugas), data inti berubah setelah ditetapkan -> PENDING (penetapan dikosongkan).
-- Tabel spike M0 medical_status/medical_detail tidak dipakai modul ini (dibersihkan terpisah).

-- ---------------------------------------------------------------- 0. helper
-- Site tempat pemanggil boleh mencatat data administratif medis (medical.update FULL atau LIMITED);
-- dipakai kebijakan dalam bentuk (select ...) agar dievaluasi sekali per kueri
create function app.medical_entry_sites() returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct ura.scope_id), '{}'::uuid[])
  from user_role_assignment ura
  join role_permission rp on rp.role_code = ura.role_code
  join user_profile up on up.id = ura.user_id and up.status = 'ACTIVE'
  where ura.user_id = app.current_user_id() and ura.scope_type = 'SITE'
    and ura.revoked_at is null and ura.valid_from <= now() and (ura.valid_until is null or ura.valid_until > now())
    and rp.permission_code = 'medical.update' and rp.constraint_level in ('FULL', 'LIMITED')
$$;
create function app.medical_entry_org_wide() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from user_role_assignment ura
    join role_permission rp on rp.role_code = ura.role_code
    join user_profile up on up.id = ura.user_id and up.status = 'ACTIVE'
    where ura.user_id = app.current_user_id() and ura.scope_type = 'ORGANIZATION'
      and ura.revoked_at is null and ura.valid_from <= now() and (ura.valid_until is null or ura.valid_until > now())
      and rp.permission_code = 'medical.update' and rp.constraint_level in ('FULL', 'LIMITED'))
$$;
revoke execute on function app.medical_entry_sites() from public;
revoke execute on function app.medical_entry_org_wide() from public;
grant execute on function app.medical_entry_sites() to app_authenticated;
grant execute on function app.medical_entry_org_wide() to app_authenticated;

-- ---------------------------------------------------------------- 1. master jenis pemeriksaan
create table medical_exam_type (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references organization (id),
  name                    text not null check (length(btrim(name)) between 2 and 150),
  code                    app.code_text not null,
  description             text check (length(description) <= 1000),
  default_validity_months integer check (default_validity_months between 1 and 600),
  status                  text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  version                 integer not null default 1,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint medical_exam_type_org_uq unique (id, organization_id)
);
create unique index medical_exam_type_code_uq on medical_exam_type (organization_id, code) where status = 'ACTIVE';
alter table medical_exam_type enable row level security;
alter table medical_exam_type force row level security;
revoke all on medical_exam_type from public;
grant select, insert, update on medical_exam_type to app_authenticated;
create policy medical_exam_type_read on medical_exam_type for select to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_any_scope('organization.read')) or (select app.has_any_scope('medical.verify'))));
create policy medical_exam_type_insert on medical_exam_type for insert to app_authenticated
  with check (organization_id = (select app.current_org()) and (select app.has_org_wide('readiness_profile.manage')));
create policy medical_exam_type_update on medical_exam_type for update to app_authenticated
  using (organization_id = (select app.current_org()) and (select app.has_org_wide('readiness_profile.manage')))
  with check (organization_id = (select app.current_org()));
create trigger medical_exam_type_version before update on medical_exam_type for each row execute function app.bump_version();
create trigger audit_medical_exam_type after insert or update on medical_exam_type
  for each row execute function app.audit_structure_change('medical_exam_type', 'readiness_profile.manage');

-- ---------------------------------------------------------------- 2. medical_record (tingkat detail)
create table medical_record (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null,
  site_id               uuid not null,
  worker_id             uuid not null,
  exam_type_id          uuid not null,
  examination_date      date not null,
  expiry_date           date not null,
  provider              text check (length(provider) <= 150),
  file_id               uuid,
  fitness_status        text check (fitness_status in ('FIT', 'FIT_WITH_RESTRICTION', 'TEMPORARILY_UNFIT', 'UNFIT')),
  unfit_until           date,
  verification_status   text not null default 'PENDING' check (verification_status in ('PENDING', 'VERIFIED', 'REJECTED')),
  verified_by           uuid references user_profile (id),
  verified_at           timestamptz,
  determination_comment text check (length(determination_comment) <= 500),
  rejection_reason      text check (length(rejection_reason) <= 500),
  created_by            uuid not null references user_profile (id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  version               integer not null default 1,
  foreign key (worker_id, organization_id, site_id) references worker (id, organization_id, site_id) on update cascade,
  foreign key (exam_type_id, organization_id) references medical_exam_type (id, organization_id),
  foreign key (file_id, organization_id) references file_object (id, organization_id),
  constraint medical_record_org_uq unique (id, organization_id),
  constraint medical_record_range_chk check (expiry_date >= examination_date),
  constraint medical_record_sod_chk check (verified_by is null or verified_by <> created_by),
  -- DB-003 §4: fitness kosong sampai ditetapkan, wajib saat VERIFIED
  constraint medical_record_fitness_chk check ((verification_status = 'VERIFIED') = (fitness_status is not null)),
  constraint medical_record_verified_chk check (verification_status <> 'VERIFIED' or (verified_by is not null and verified_at is not null)),
  constraint medical_record_unfit_until_chk check ((fitness_status = 'TEMPORARILY_UNFIT') = (unfit_until is not null)),
  constraint medical_record_rejected_chk check (verification_status <> 'REJECTED'
                                                or (verified_by is not null and length(btrim(coalesce(rejection_reason, ''))) > 0))
);
create index medical_record_worker_idx on medical_record (worker_id, examination_date desc);
create index medical_record_queue_idx on medical_record (organization_id, verification_status, updated_at)
  where verification_status = 'PENDING';
create unique index medical_record_file_uq on medical_record (file_id) where file_id is not null;

create table medical_access_grant (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null,
  medical_record_id uuid not null,
  grantee_user_id   uuid not null references user_profile (id),
  granted_by        uuid not null references user_profile (id),
  reason            text not null check (length(btrim(reason)) > 0 and length(reason) <= 500),
  starts_at         timestamptz not null default now(),
  expires_at        timestamptz not null,
  revoked_at        timestamptz,
  created_at        timestamptz not null default now(),
  foreign key (medical_record_id, organization_id) references medical_record (id, organization_id),
  constraint medical_access_grant_self_chk check (granted_by <> grantee_user_id),
  constraint medical_access_grant_window_chk check (expires_at > starts_at and expires_at <= starts_at + interval '24 hours')
);
create index medical_access_grant_lookup_idx on medical_access_grant (grantee_user_id, medical_record_id);

-- record dengan otorisasi detail aktif bagi pemanggil (HSE Manager)
create function app.my_medical_grants() returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct g.medical_record_id), '{}'::uuid[]) from medical_access_grant g
  where g.grantee_user_id = app.current_user_id() and g.revoked_at is null and g.starts_at <= now() and g.expires_at > now()
$$;
revoke execute on function app.my_medical_grants() from public;
grant execute on function app.my_medical_grants() to app_authenticated;

create function app.medical_record_guard() returns trigger
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
  -- data inti berubah pada record ditetapkan/ditolak -> PENDING, penetapan dikosongkan (MED-API-009)
  if (new.exam_type_id, new.examination_date, new.expiry_date, new.provider, new.file_id)
     is distinct from (old.exam_type_id, old.examination_date, old.expiry_date, old.provider, old.file_id)
     and new.verification_status = old.verification_status and old.verification_status <> 'PENDING' then
    new.verification_status := 'PENDING';
    new.fitness_status := null;
    new.unfit_until := null;
    new.verified_by := null;
    new.verified_at := null;
    new.determination_comment := null;
    new.rejection_reason := null;
    update medical_restriction set status = 'LIFTED', lift_reason = 'Record medis diajukan ulang', lifted_at = now()
     where medical_record_id = new.id and status = 'ACTIVE';
  end if;
  if new.verification_status <> old.verification_status and new.verification_status <> 'PENDING' then
    if old.verification_status <> 'PENDING' then
      raise exception 'INVALID_STATE_TRANSITION: penetapan hanya dari PENDING' using errcode = '23514';
    end if;
    -- penetapan/penolakan: hanya medical.verify penuh di Site record, tercatat sebagai pelaku
    if app.current_user_id() is not null
       and (not app.has_permission('medical.verify', new.site_id) or new.verified_by is distinct from app.current_user_id()) then
      raise exception 'penetapan Fit to Work hanya oleh Medical Officer' using errcode = '42501';
    end if;
  elsif new.verification_status = old.verification_status
        and (new.fitness_status, new.unfit_until) is distinct from (old.fitness_status, old.unfit_until) then
    raise exception 'INVALID_STATE_TRANSITION: Fit to Work hanya berubah lewat penetapan' using errcode = '23514';
  end if;
  return new;
end $$;
revoke execute on function app.medical_record_guard() from public;
create trigger medical_record_guard before insert or update on medical_record
  for each row execute function app.medical_record_guard();
create trigger medical_record_version before update on medical_record for each row execute function app.bump_version();

alter table medical_record enable row level security;
alter table medical_record force row level security;
revoke all on medical_record from public;
grant select, insert on medical_record to app_authenticated;
grant update (exam_type_id, examination_date, expiry_date, provider, file_id, fitness_status, unfit_until,
              verification_status, verified_by, verified_at, determination_comment, rejection_reason)
  on medical_record to app_authenticated;
-- tingkat detail
create policy medical_record_read on medical_record for select to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('medical.read_detail'))
              or site_id = any ((select app.permitted_sites('medical.read_detail'))::uuid[])
              or (worker_id = (select app.my_worker_id()) and (select app.has_self_permission('medical.read_detail')))
              or (created_by = (select app.current_user_id()) and verification_status <> 'VERIFIED')
              or id = any ((select app.my_medical_grants())::uuid[])));
create policy medical_record_insert on medical_record for insert to app_authenticated
  with check (organization_id = (select app.current_org()) and created_by = (select app.current_user_id())
              and verification_status = 'PENDING' and fitness_status is null and verified_by is null
              and ((select app.medical_entry_org_wide()) or site_id = any ((select app.medical_entry_sites())::uuid[])));
create policy medical_record_update on medical_record for update to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.medical_entry_org_wide()) or site_id = any ((select app.medical_entry_sites())::uuid[])
              or (select app.has_org_wide('medical.verify'))
              or site_id = any ((select app.permitted_sites('medical.verify'))::uuid[])))
  with check (organization_id = (select app.current_org())
              and (verification_status = 'PENDING' or verified_by = (select app.current_user_id())));

-- dokumen MCU: terlihat oleh yang dapat membaca detail record pemiliknya (bucket soh-medical)
create policy file_object_read_medical on file_object for select to app_authenticated
  using (organization_id = (select app.current_org()) and deleted_at is null and purpose = 'MEDICAL_DOCUMENT'
         and exists (select 1 from medical_record m where m.file_id = file_object.id));

-- ---------------------------------------------------------------- 3. pembatasan operasional
create table medical_restriction (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null,
  medical_record_id       uuid not null,
  restriction_code        text not null check (restriction_code ~ '^[A-Z][A-Z0-9_]{2,49}$'),
  -- hanya batasan kerja; dilarang diagnosis/kondisi medis (O-02: panduan dan peninjauan, tidak terdeteksi otomatis)
  operational_description text not null check (length(btrim(operational_description)) between 5 and 300),
  valid_from              date not null,
  valid_until             date,
  status                  text not null default 'ACTIVE' check (status in ('ACTIVE', 'LIFTED')),
  lift_reason             text check (length(lift_reason) <= 500),
  lifted_by               uuid references user_profile (id),
  lifted_at               timestamptz,
  created_by              uuid not null references user_profile (id),
  created_at              timestamptz not null default now(),
  foreign key (medical_record_id, organization_id) references medical_record (id, organization_id),
  constraint medical_restriction_range_chk check (valid_until is null or valid_until >= valid_from),
  constraint medical_restriction_lift_chk check (status = 'ACTIVE' or (length(btrim(coalesce(lift_reason, ''))) > 0 and lifted_at is not null))
);
create index medical_restriction_record_idx on medical_restriction (medical_record_id);

create function app.medical_restriction_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_site uuid;
  v_fitness text;
begin
  select site_id, fitness_status into v_site, v_fitness from medical_record where id = new.medical_record_id;
  if app.current_user_id() is not null and not app.has_permission('medical.verify', v_site) then
    raise exception 'pembatasan medis hanya oleh Medical Officer' using errcode = '42501';
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
revoke execute on function app.medical_restriction_guard() from public;
create trigger medical_restriction_guard before insert or update on medical_restriction
  for each row execute function app.medical_restriction_guard();

alter table medical_restriction enable row level security;
alter table medical_restriction force row level security;
revoke all on medical_restriction from public;
grant select, insert on medical_restriction to app_authenticated;
grant update (status, lift_reason, lifted_by, lifted_at) on medical_restriction to app_authenticated;
-- baca langsung mengikuti tingkat detail; tingkat status lewat app.medical_status
create policy medical_restriction_read on medical_restriction for select to app_authenticated
  using (organization_id = (select app.current_org())
         and exists (select 1 from medical_record m where m.id = medical_record_id));
create policy medical_restriction_insert on medical_restriction for insert to app_authenticated
  with check (organization_id = (select app.current_org()) and created_by = (select app.current_user_id()) and status = 'ACTIVE');
create policy medical_restriction_update on medical_restriction for update to app_authenticated
  using (organization_id = (select app.current_org()) and exists (select 1 from medical_record m where m.id = medical_record_id))
  with check (organization_id = (select app.current_org()));

-- ---------------------------------------------------------------- 4. otorisasi akses detail
create function app.medical_access_grant_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r medical_record%rowtype;
begin
  select * into r from medical_record where id = new.medical_record_id;
  if app.current_user_id() is not null and not (
       app.has_permission('medical.verify', r.site_id)
       or coalesce(r.worker_id = app.my_worker_id(), false)) then
    raise exception 'otorisasi akses medis hanya oleh Medical Officer atau pekerja pemilik data' using errcode = '42501';
  end if;
  -- penerima harus memegang medical.read_detail tingkat LIMITED (HSE Manager, PB-009)
  if not exists (
       select 1 from user_role_assignment ura join role_permission rp on rp.role_code = ura.role_code
        where ura.user_id = new.grantee_user_id and ura.organization_id = new.organization_id and ura.revoked_at is null
          and rp.permission_code = 'medical.read_detail' and rp.constraint_level = 'LIMITED') then
    raise exception 'GRANTEE_NOT_ELIGIBLE: penerima tidak berhak menerima otorisasi akses medis' using errcode = '23514';
  end if;
  return new;
end $$;
revoke execute on function app.medical_access_grant_guard() from public;
create trigger medical_access_grant_guard before insert on medical_access_grant
  for each row execute function app.medical_access_grant_guard();

-- calon penerima otorisasi (id dan nama saja) untuk Medical Officer
create function app.medical_grantees() returns table (id uuid, full_name text)
language sql stable security definer set search_path = public, pg_temp as $$
  select up.id, up.full_name from user_profile up
  where app.has_org_wide('medical.verify') and up.organization_id = app.current_org() and up.status = 'ACTIVE'
    and up.id <> app.current_user_id()
    and exists (select 1 from user_role_assignment ura join role_permission rp on rp.role_code = ura.role_code
                where ura.user_id = up.id and ura.revoked_at is null
                  and rp.permission_code = 'medical.read_detail' and rp.constraint_level = 'LIMITED')
  order by up.full_name
$$;
revoke execute on function app.medical_grantees() from public;
grant execute on function app.medical_grantees() to app_authenticated;

alter table medical_access_grant enable row level security;
alter table medical_access_grant force row level security;
revoke all on medical_access_grant from public;
grant select, insert on medical_access_grant to app_authenticated;
grant update (revoked_at) on medical_access_grant to app_authenticated;
create policy medical_access_grant_read on medical_access_grant for select to app_authenticated
  using (organization_id = (select app.current_org())
         and (grantee_user_id = (select app.current_user_id()) or granted_by = (select app.current_user_id())
              or (select app.has_org_wide('medical.verify'))));
create policy medical_access_grant_insert on medical_access_grant for insert to app_authenticated
  with check (organization_id = (select app.current_org()) and granted_by = (select app.current_user_id()));
create policy medical_access_grant_update on medical_access_grant for update to app_authenticated
  using (organization_id = (select app.current_org())
         and (granted_by = (select app.current_user_id()) or (select app.has_org_wide('medical.verify'))))
  with check (organization_id = (select app.current_org()));

-- ---------------------------------------------------------------- 5. tingkat status (DB-008 v_medical_status)
-- Satu baris per pekerja yang boleh dilihat pemanggil (medical.read_status sesuai scope). Dasar: record VERIFIED dengan
-- tanggal pemeriksaan terbaru. Tanpa file, penyedia, jenis pemeriksaan, komentar, alasan penolakan.
create function app.medical_status(p_worker uuid)
returns table (worker_id uuid, fitness_status text, validity_status text, expiry_date date, unfit_until date,
               restrictions jsonb, has_pending boolean)
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
           when l.fitness_status in ('UNFIT', 'TEMPORARILY_UNFIT') then 'SUSPENDED'
           when l.expiry_date < app.site_today(w.site_id) then 'EXPIRED'
           when l.expiry_date <= app.site_today(w.site_id) + 30 then 'EXPIRING_SOON'
           else 'VALID' end,
         l.expiry_date,
         l.unfit_until,
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

-- ---------------------------------------------------------------- 6. audit (API-005 §12)
-- Perubahan record dicatat sensitif: tanpa nilai lama/baru Fit to Work di payload (hanya nama kolom).
create function app.audit_medical() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_new jsonb := to_jsonb(new) - 'updated_at' - 'version';
  v_old jsonb;
  v_fields text[];
  v_action text;
  v_site uuid;
  v_entity uuid;
begin
  if tg_table_name = 'medical_restriction' then
    select site_id into v_site from medical_record where id = new.medical_record_id;
    v_action := case when tg_op = 'INSERT' then 'medical.restriction_add' else 'medical.restriction_lift' end;
    perform app.audit_enqueue(new.organization_id, v_action, 'medical_record', new.medical_record_id,
      array['restriction_code', 'status'], null, 'medical.verify', v_site);
    return null;
  end if;
  if tg_table_name = 'medical_access_grant' then
    select site_id into v_site from medical_record where id = new.medical_record_id;
    perform app.audit_enqueue(new.organization_id,
      case when tg_op = 'INSERT' then 'medical.access_grant' else 'medical.access_grant_revoke' end,
      'medical_record', new.medical_record_id, array['grantee_user_id', 'expires_at'],
      jsonb_build_object('grantee_user_id', new.grantee_user_id, 'expires_at', new.expires_at), 'medical.verify', v_site);
    return null;
  end if;
  if tg_op = 'INSERT' then
    select array_agg(k order by k) into v_fields from jsonb_object_keys(v_new) k where k not in ('id', 'organization_id', 'created_at');
    perform app.audit_enqueue(new.organization_id, 'medical.create', 'medical_record', new.id, v_fields, null,
      'medical.update', new.site_id);
    return null;
  end if;
  v_old := to_jsonb(old) - 'updated_at' - 'version';
  select array_agg(k order by k) into v_fields from jsonb_object_keys(v_new) k where v_new->k is distinct from v_old->k;
  if v_fields is null then return null; end if;
  v_action := case
    when new.verification_status = 'VERIFIED' and old.verification_status = 'PENDING' then 'medical.verify'
    when new.verification_status = 'REJECTED' and old.verification_status = 'PENDING' then 'medical.reject'
    when new.verification_status = 'PENDING' and old.verification_status <> 'PENDING' then 'medical.resubmit'
    else 'medical.update' end;
  perform app.audit_enqueue(new.organization_id, v_action, 'medical_record', new.id, v_fields, null,
    case when v_action in ('medical.verify', 'medical.reject') then 'medical.verify' else 'medical.update' end, new.site_id);
  return null;
end $$;
revoke execute on function app.audit_medical() from public;
create trigger audit_medical_record after insert or update on medical_record
  for each row execute function app.audit_medical();
create trigger audit_medical_restriction after insert or update on medical_restriction
  for each row execute function app.audit_medical();
create trigger audit_medical_access_grant after insert or update of revoked_at on medical_access_grant
  for each row execute function app.audit_medical();

-- 0016: Kompetensi (M3.2)
-- Sumber: DB-003 §2.1 dan §3 (competency, worker_competency, competency_certificate), SRS-WF003 (BR-004/005/011/012/013/015),
-- API-004, PB-009 (competency.read/update/verify, readiness_profile.manage). B-05 pemisahan tugas.
-- Tabel spike `competency_record` (M0) tidak diubah; digantikan saat Readiness Engine (M4).
-- Data sintetis saja (B-24).

-- ---------------------------------------------------------------- 0. tanggal lokal Site (BR-WF003-015)
-- Hanya tanggal, tanpa data lain; dipakai menghitung status berlaku walau pemanggil tidak dapat membaca Site.
create function app.site_today(p_site uuid) returns date
language sql stable security definer set search_path = public, pg_temp as $$
  select (now() at time zone coalesce((select timezone from site where id = p_site), 'Asia/Jakarta'))::date
$$;
revoke execute on function app.site_today(uuid) from public;
grant execute on function app.site_today(uuid) to app_authenticated;

-- ---------------------------------------------------------------- 1. master kompetensi
-- permission tingkat SELF (mis. WORKER competency.update SELF): hanya atas record dirinya sendiri (PB-009)
create function app.has_self_permission(perm text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.my_worker_id() is not null and exists (
    select 1 from app.my_permissions() p where p.permission_code = perm and p.constraint_level = 'SELF')
$$;
revoke execute on function app.has_self_permission(text) from public;
grant execute on function app.has_self_permission(text) to app_authenticated;

create table competency (
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
  constraint competency_org_uq unique (id, organization_id)
);
create unique index competency_code_uq on competency (organization_id, code) where status = 'ACTIVE';
alter table competency enable row level security;
alter table competency force row level security;
revoke all on competency from public;
grant select, insert, update on competency to app_authenticated;
create policy competency_read on competency for select to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_any_scope('organization.read')) or (select app.has_self_permission('competency.update'))));
create policy competency_insert on competency for insert to app_authenticated
  with check (organization_id = (select app.current_org()) and (select app.has_org_wide('readiness_profile.manage')));
create policy competency_update on competency for update to app_authenticated
  using (organization_id = (select app.current_org()) and (select app.has_org_wide('readiness_profile.manage')))
  with check (organization_id = (select app.current_org()));
create trigger competency_version before update on competency for each row execute function app.bump_version();
create trigger audit_competency after insert or update on competency
  for each row execute function app.audit_structure_change('competency', 'readiness_profile.manage');

-- ---------------------------------------------------------------- 2. kompetensi pekerja
create table worker_competency (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null,
  site_id             uuid not null,
  worker_id           uuid not null,
  competency_id       uuid not null,
  valid_from          date not null,
  valid_until         date,
  source              text not null default 'CERTIFICATE' check (source in ('CERTIFICATE', 'TRAINING', 'ASSESSMENT', 'OTHER')),
  verification_status text not null default 'PENDING' check (verification_status in ('PENDING', 'VERIFIED', 'REJECTED')),
  verified_by         uuid references user_profile (id),
  verified_at         timestamptz,
  verification_comment text check (length(verification_comment) <= 500),
  rejection_reason    text check (length(rejection_reason) <= 500),
  created_by          uuid not null references user_profile (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             integer not null default 1,
  -- Site ikut pekerja saat mutasi (penempatan), seperti data turunan lain
  foreign key (worker_id, organization_id, site_id) references worker (id, organization_id, site_id) on update cascade,
  foreign key (competency_id, organization_id) references competency (id, organization_id),
  constraint worker_competency_org_uq unique (id, organization_id),
  constraint worker_competency_range_chk check (valid_until is null or valid_until >= valid_from),
  -- DB-003 §2.1: pemisahan tugas, VERIFIED lengkap, REJECTED beralasan
  constraint worker_competency_sod_chk check (verified_by is null or verified_by <> created_by),
  constraint worker_competency_verified_chk check (verification_status <> 'VERIFIED' or (verified_by is not null and verified_at is not null)),
  constraint worker_competency_rejected_chk check (verification_status <> 'REJECTED'
                                                   or (verified_by is not null and length(btrim(coalesce(rejection_reason, ''))) > 0))
);
create index worker_competency_worker_idx on worker_competency (worker_id, competency_id);
create index worker_competency_queue_idx on worker_competency (organization_id, verification_status, created_at)
  where verification_status = 'PENDING';

-- data inti berubah pada record VERIFIED/REJECTED -> kembali PENDING (BR-WF003-012, -013)
create function app.worker_competency_resubmit() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if (new.valid_from, new.valid_until, new.competency_id, new.source)
     is distinct from (old.valid_from, old.valid_until, old.competency_id, old.source)
     and new.verification_status = old.verification_status and old.verification_status <> 'PENDING' then
    new.verification_status := 'PENDING';
    new.verified_by := null;
    new.verified_at := null;
    new.verification_comment := null;
    new.rejection_reason := null;
  end if;
  -- verifikasi/penolakan hanya dari PENDING
  if new.verification_status <> old.verification_status and new.verification_status <> 'PENDING'
     and old.verification_status <> 'PENDING' then
    raise exception 'INVALID_STATE_TRANSITION: verifikasi hanya dari PENDING' using errcode = '23514';
  end if;
  return new;
end $$;
revoke execute on function app.worker_competency_resubmit() from public;
create trigger worker_competency_resubmit before update on worker_competency
  for each row execute function app.worker_competency_resubmit();
create trigger worker_competency_version before update on worker_competency for each row execute function app.bump_version();

alter table worker_competency enable row level security;
alter table worker_competency force row level security;
revoke all on worker_competency from public;
grant select, insert on worker_competency to app_authenticated;
grant update (valid_from, valid_until, source, verification_status, verified_by, verified_at, verification_comment,
              rejection_reason) on worker_competency to app_authenticated;

-- baca: scope organisasi, Site, Tim, kontraktor, atau data diri (PB-009 competency.read)
create policy worker_competency_read on worker_competency for select to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('competency.read'))
              or site_id = any ((select app.permitted_sites('competency.read'))::uuid[])
              or worker_id = any ((select app.permitted_team_workers('competency.read'))::uuid[])
              or worker_id in (select w.id from worker w
                               where w.contractor_id = any ((select app.permitted_contractors('competency.read'))::uuid[]))
              or worker_id = (select app.my_worker_id())));
create policy worker_competency_insert on worker_competency for insert to app_authenticated
  with check (organization_id = (select app.current_org()) and created_by = (select app.current_user_id())
              and verification_status = 'PENDING' and verified_by is null
              and ((select app.has_org_wide('competency.update'))
                   or site_id = any ((select app.permitted_sites('competency.update'))::uuid[])
                   or (worker_id = (select app.my_worker_id()) and (select app.has_self_permission('competency.update')))));
-- ubah data (competency.update) atau verifikasi (competency.verify) dalam scope Site
create policy worker_competency_update on worker_competency for update to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('competency.update')) or site_id = any ((select app.permitted_sites('competency.update'))::uuid[])
              or (select app.has_org_wide('competency.verify')) or site_id = any ((select app.permitted_sites('competency.verify'))::uuid[])
              or (worker_id = (select app.my_worker_id()) and (select app.has_self_permission('competency.update')))))
  with check (organization_id = (select app.current_org())
              -- yang menetapkan VERIFIED/REJECTED adalah pemanggil, bukan nilai bebas
              and (verification_status = 'PENDING'
                   or (verified_by = (select app.current_user_id())
                       and ((select app.has_org_wide('competency.verify'))
                            or site_id = any ((select app.permitted_sites('competency.verify'))::uuid[])))));

-- ---------------------------------------------------------------- 3. sertifikat
create table competency_certificate (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null,
  worker_competency_id uuid not null,
  certificate_number   text check (length(certificate_number) <= 100),
  issuer               text check (length(issuer) <= 150),
  issue_date           date not null,
  expiry_date          date,
  file_id              uuid,
  created_by           uuid not null references user_profile (id),
  created_at           timestamptz not null default now(),
  foreign key (worker_competency_id, organization_id) references worker_competency (id, organization_id),
  foreign key (file_id, organization_id) references file_object (id, organization_id),
  constraint competency_certificate_range_chk check (expiry_date is null or expiry_date >= issue_date)
);
create index competency_certificate_wc_idx on competency_certificate (worker_competency_id);
create unique index competency_certificate_file_uq on competency_certificate (file_id) where file_id is not null;

-- berkas wajib CLEAN, bertujuan sertifikat; sertifikat baru pada record terverifikasi -> PENDING (BR-WF003-012)
create function app.competency_certificate_check() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.file_id is not null and not exists (
       select 1 from file_object f where f.id = new.file_id and f.organization_id = new.organization_id
         and f.scan_status = 'CLEAN' and f.purpose = 'COMPETENCY_CERTIFICATE' and f.deleted_at is null) then
    raise exception 'FILE_NOT_CLEAN: berkas belum lolos pemeriksaan atau bukan sertifikat' using errcode = '23514';
  end if;
  update worker_competency set verification_status = 'PENDING', verified_by = null, verified_at = null,
         verification_comment = null, rejection_reason = null
   where id = new.worker_competency_id and verification_status <> 'PENDING';
  return new;
end $$;
revoke execute on function app.competency_certificate_check() from public;
create trigger competency_certificate_check before insert on competency_certificate
  for each row execute function app.competency_certificate_check();

alter table competency_certificate enable row level security;
alter table competency_certificate force row level security;
revoke all on competency_certificate from public;
grant select, insert on competency_certificate to app_authenticated;
-- terlihat bila record kompetensinya terlihat (RLS worker_competency berlaku di subkueri)
create policy competency_certificate_read on competency_certificate for select to app_authenticated
  using (organization_id = (select app.current_org())
         and exists (select 1 from worker_competency wc where wc.id = worker_competency_id));
create policy competency_certificate_insert on competency_certificate for insert to app_authenticated
  with check (organization_id = (select app.current_org()) and created_by = (select app.current_user_id())
              and exists (select 1 from worker_competency wc where wc.id = worker_competency_id
                          and ((select app.has_org_wide('competency.update'))
                               or wc.site_id = any ((select app.permitted_sites('competency.update'))::uuid[])
                               or (wc.worker_id = (select app.my_worker_id())
                                   and (select app.has_self_permission('competency.update'))))));

-- berkas sertifikat terlihat oleh yang dapat melihat sertifikatnya (unduh lewat record pemilik, DB-008 §3.2)
create policy file_object_read_certificate on file_object for select to app_authenticated
  using (organization_id = (select app.current_org()) and deleted_at is null and purpose = 'COMPETENCY_CERTIFICATE'
         and exists (select 1 from competency_certificate cc where cc.file_id = file_object.id));

-- ---------------------------------------------------------------- 4. audit
create function app.audit_worker_competency() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_new jsonb := to_jsonb(new) - 'updated_at' - 'version';
  v_old jsonb;
  v_fields text[];
  v_changes jsonb;
  v_action text;
begin
  if tg_table_name = 'competency_certificate' then
    perform app.audit_enqueue(new.organization_id, 'competency.certificate_add', 'worker_competency', new.worker_competency_id,
      array['certificate_number', 'issuer', 'issue_date', 'expiry_date', 'file_id'],
      jsonb_build_object('certificate_number', new.certificate_number, 'issuer', new.issuer, 'issue_date', new.issue_date,
                         'expiry_date', new.expiry_date, 'file_id', new.file_id),
      'competency.update', null);
    return null;
  end if;
  if tg_op = 'INSERT' then
    select array_agg(k order by k) into v_fields from jsonb_object_keys(v_new) k where k not in ('id', 'organization_id', 'created_at');
    perform app.audit_enqueue(new.organization_id, 'competency.create', 'worker_competency', new.id, v_fields,
      v_new - 'id' - 'organization_id' - 'created_at', 'competency.update', new.site_id);
    return null;
  end if;
  v_old := to_jsonb(old) - 'updated_at' - 'version';
  select array_agg(k order by k), jsonb_object_agg(k, jsonb_build_object('from', v_old->k, 'to', v_new->k))
  into v_fields, v_changes from jsonb_object_keys(v_new) k where v_new->k is distinct from v_old->k;
  if v_fields is null then return null; end if;
  v_action := case
    when new.verification_status = 'VERIFIED' and old.verification_status = 'PENDING' then 'competency.verify'
    when new.verification_status = 'REJECTED' and old.verification_status = 'PENDING' then 'competency.reject'
    when new.verification_status = 'PENDING' and old.verification_status <> 'PENDING' then 'competency.resubmit'
    else 'competency.update' end;
  perform app.audit_enqueue(new.organization_id, v_action, 'worker_competency', new.id, v_fields, v_changes,
    case when v_action in ('competency.verify', 'competency.reject') then 'competency.verify' else 'competency.update' end,
    new.site_id);
  return null;
end $$;
revoke execute on function app.audit_worker_competency() from public;
create trigger audit_worker_competency after insert or update on worker_competency
  for each row execute function app.audit_worker_competency();
create trigger audit_competency_certificate after insert on competency_certificate
  for each row execute function app.audit_worker_competency();

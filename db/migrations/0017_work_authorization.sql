-- 0017_work_authorization.sql: Otorisasi Kerja (WF005, API-006, DB-003 §2.1/§2.2/§5).
-- Bukan Permit To Work (B-04): jalur /permits dicadangkan untuk PTW (P4).
-- - authorization_type: master, dikelola readiness_profile.manage, kolom mandatory tidak ada (Requirement Profile, B-12).
-- - worker_authorization: milik satu pekerja; verifikasi dengan pemisahan tugas (sama dengan kompetensi, 0016);
--   pembekuan NONE -> SUSPENDED -> NONE, NONE/SUSPENDED -> REVOKED (akhir), hanya authorization.verify penuh, beralasan.
-- - Data inti berubah pada record VERIFIED/REJECTED -> PENDING (WR-004). Dokumen lewat file_object CLEAN.

-- ---------------------------------------------------------------- 1. master jenis otorisasi
create table authorization_type (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references organization (id),
  name                    text not null check (length(btrim(name)) between 2 and 150),
  code                    app.code_text not null,
  description             text check (length(description) <= 1000),
  requires_work_scope     boolean not null default false,
  default_validity_months integer check (default_validity_months between 1 and 600),
  status                  text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE')),
  version                 integer not null default 1,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint authorization_type_org_uq unique (id, organization_id)
);
create unique index authorization_type_code_uq on authorization_type (organization_id, code) where status = 'ACTIVE';
alter table authorization_type enable row level security;
alter table authorization_type force row level security;
revoke all on authorization_type from public;
grant select, insert, update on authorization_type to app_authenticated;
create policy authorization_type_read on authorization_type for select to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_any_scope('organization.read')) or (select app.has_self_permission('authorization.update'))));
create policy authorization_type_insert on authorization_type for insert to app_authenticated
  with check (organization_id = (select app.current_org()) and (select app.has_org_wide('readiness_profile.manage')));
create policy authorization_type_update on authorization_type for update to app_authenticated
  using (organization_id = (select app.current_org()) and (select app.has_org_wide('readiness_profile.manage')))
  with check (organization_id = (select app.current_org()));
create trigger authorization_type_version before update on authorization_type for each row execute function app.bump_version();
create trigger audit_authorization_type after insert or update on authorization_type
  for each row execute function app.audit_structure_change('authorization_type', 'readiness_profile.manage');

-- ---------------------------------------------------------------- 2. Otorisasi Kerja pekerja
create table worker_authorization (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null,
  site_id               uuid not null,
  worker_id             uuid not null,
  authorization_type_id uuid not null,
  authorization_number  text check (length(authorization_number) <= 100),
  issuer                text check (length(issuer) <= 150),
  work_scope            text check (length(work_scope) <= 500),
  restriction_note      text check (length(restriction_note) <= 500),
  valid_from            date not null,
  valid_until           date,
  file_id               uuid,
  verification_status   text not null default 'PENDING' check (verification_status in ('PENDING', 'VERIFIED', 'REJECTED')),
  verified_by           uuid references user_profile (id),
  verified_at           timestamptz,
  verification_comment  text check (length(verification_comment) <= 500),
  rejection_reason      text check (length(rejection_reason) <= 500),
  suspension_status     text not null default 'NONE' check (suspension_status in ('NONE', 'SUSPENDED', 'REVOKED')),
  suspended_by          uuid references user_profile (id),
  suspended_at          timestamptz,
  suspension_reason     text check (length(suspension_reason) <= 500),
  created_by            uuid not null references user_profile (id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  version               integer not null default 1,
  foreign key (worker_id, organization_id, site_id) references worker (id, organization_id, site_id) on update cascade,
  foreign key (authorization_type_id, organization_id) references authorization_type (id, organization_id),
  foreign key (file_id, organization_id) references file_object (id, organization_id),
  constraint worker_authorization_org_uq unique (id, organization_id),
  constraint worker_authorization_range_chk check (valid_until is null or valid_until >= valid_from),
  constraint worker_authorization_sod_chk check (verified_by is null or verified_by <> created_by),
  constraint worker_authorization_verified_chk check (verification_status <> 'VERIFIED' or (verified_by is not null and verified_at is not null)),
  constraint worker_authorization_rejected_chk check (verification_status <> 'REJECTED'
                                                      or (verified_by is not null and length(btrim(coalesce(rejection_reason, ''))) > 0)),
  -- DB-003 §2.2: pembekuan/pencabutan beralasan dan tercatat pelakunya
  constraint worker_authorization_suspension_chk check (suspension_status = 'NONE'
                                                        or (length(btrim(coalesce(suspension_reason, ''))) > 0
                                                            and suspended_by is not null and suspended_at is not null))
);
create index worker_authorization_worker_idx on worker_authorization (worker_id, authorization_type_id);
create index worker_authorization_queue_idx on worker_authorization (organization_id, verification_status, updated_at)
  where verification_status = 'PENDING';
create unique index worker_authorization_file_uq on worker_authorization (file_id) where file_id is not null;

-- Aturan status (BR-WF005-013..015):
-- - data inti berubah pada VERIFIED/REJECTED -> PENDING; verifikasi/penolakan hanya dari PENDING
-- - REVOKED akhir: tidak ada perubahan apa pun setelahnya
-- - transisi pembekuan sah saja, hanya oleh authorization.verify penuh di Site record (bukan pekerja, bukan HSE Officer)
-- - berkas dokumen wajib CLEAN, bertujuan AUTHORIZATION_DOCUMENT, diunggah pemanggil
create function app.worker_authorization_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.file_id is not null and (tg_op = 'INSERT' or new.file_id is distinct from old.file_id) and not exists (
       select 1 from file_object f where f.id = new.file_id and f.organization_id = new.organization_id
         and f.scan_status = 'CLEAN' and f.purpose = 'AUTHORIZATION_DOCUMENT' and f.deleted_at is null
         -- berkas milik pemanggil (tidak dapat menempelkan berkas orang lain dengan menebak id)
         and (app.current_user_id() is null or f.uploaded_by = app.current_user_id())) then
    raise exception 'FILE_NOT_CLEAN: berkas belum lolos pemeriksaan atau bukan dokumen otorisasi' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if new.suspension_status <> 'NONE' and app.current_user_id() is not null then
      raise exception 'INVALID_STATE_TRANSITION: record baru tidak dapat dibekukan' using errcode = '23514';
    end if;
    return new;
  end if;
  if old.suspension_status = 'REVOKED' then
    raise exception 'INVALID_STATE_TRANSITION: otorisasi dicabut bersifat akhir' using errcode = '23514';
  end if;
  if new.suspension_status is distinct from old.suspension_status then
    if not ((old.suspension_status = 'NONE' and new.suspension_status in ('SUSPENDED', 'REVOKED'))
            or (old.suspension_status = 'SUSPENDED' and new.suspension_status in ('NONE', 'REVOKED'))) then
      raise exception 'INVALID_STATE_TRANSITION: transisi pembekuan tidak sah' using errcode = '23514';
    end if;
    -- pengguna aplikasi: wajib authorization.verify penuh di Site record dan tercatat sebagai pelaku
    if app.current_user_id() is not null
       and (not app.has_permission('authorization.verify', new.site_id) or new.suspended_by is distinct from app.current_user_id()) then
      raise exception 'pembekuan hanya oleh pemegang authorization.verify penuh' using errcode = '42501';
    end if;
    if new.suspension_status = 'NONE' then
      new.suspended_by := null;
      new.suspended_at := null;
    end if;
  elsif (new.suspended_by, new.suspended_at, new.suspension_reason)
        is distinct from (old.suspended_by, old.suspended_at, old.suspension_reason) then
    raise exception 'INVALID_STATE_TRANSITION: kolom pembekuan hanya berubah lewat aksi pembekuan' using errcode = '23514';
  end if;
  if (new.authorization_type_id, new.authorization_number, new.issuer, new.work_scope, new.restriction_note,
      new.valid_from, new.valid_until, new.file_id)
     is distinct from (old.authorization_type_id, old.authorization_number, old.issuer, old.work_scope, old.restriction_note,
                       old.valid_from, old.valid_until, old.file_id)
     and new.verification_status = old.verification_status and old.verification_status <> 'PENDING' then
    new.verification_status := 'PENDING';
    new.verified_by := null;
    new.verified_at := null;
    new.verification_comment := null;
    new.rejection_reason := null;
  end if;
  if new.verification_status <> old.verification_status and new.verification_status <> 'PENDING'
     and old.verification_status <> 'PENDING' then
    raise exception 'INVALID_STATE_TRANSITION: verifikasi hanya dari PENDING' using errcode = '23514';
  end if;
  return new;
end $$;
revoke execute on function app.worker_authorization_guard() from public;
create trigger worker_authorization_guard before insert or update on worker_authorization
  for each row execute function app.worker_authorization_guard();
create trigger worker_authorization_version before update on worker_authorization for each row execute function app.bump_version();

alter table worker_authorization enable row level security;
alter table worker_authorization force row level security;
revoke all on worker_authorization from public;
grant select, insert on worker_authorization to app_authenticated;
grant update (authorization_type_id, authorization_number, issuer, work_scope, restriction_note, valid_from, valid_until, file_id,
              verification_status, verified_by, verified_at, verification_comment, rejection_reason,
              suspension_status, suspended_by, suspended_at, suspension_reason) on worker_authorization to app_authenticated;
create policy worker_authorization_read on worker_authorization for select to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('authorization.read'))
              or site_id = any ((select app.permitted_sites('authorization.read'))::uuid[])
              or worker_id = any ((select app.permitted_team_workers('authorization.read'))::uuid[])
              or worker_id in (select w.id from worker w
                               where w.contractor_id = any ((select app.permitted_contractors('authorization.read'))::uuid[]))
              or worker_id = (select app.my_worker_id())));
create policy worker_authorization_insert on worker_authorization for insert to app_authenticated
  with check (organization_id = (select app.current_org()) and created_by = (select app.current_user_id())
              and verification_status = 'PENDING' and verified_by is null and suspension_status = 'NONE'
              and ((select app.has_org_wide('authorization.update'))
                   or site_id = any ((select app.permitted_sites('authorization.update'))::uuid[])
                   or (worker_id = (select app.my_worker_id()) and (select app.has_self_permission('authorization.update')))));
create policy worker_authorization_update on worker_authorization for update to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('authorization.update'))
              or site_id = any ((select app.permitted_sites('authorization.update'))::uuid[])
              or (select app.has_org_wide('authorization.verify'))
              or site_id = any ((select app.permitted_sites('authorization.verify'))::uuid[])
              or (worker_id = (select app.my_worker_id()) and (select app.has_self_permission('authorization.update')))))
  with check (organization_id = (select app.current_org())
              and (verification_status = 'PENDING'
                   or (verified_by = (select app.current_user_id())
                       and ((select app.has_org_wide('authorization.verify'))
                            or site_id = any ((select app.permitted_sites('authorization.verify'))::uuid[])))
                   -- pembekuan record terverifikasi oleh orang lain: diperiksa pemicu (authorization.verify penuh)
                   or suspended_by = (select app.current_user_id())));

-- dokumen otorisasi terlihat oleh yang dapat melihat record pemiliknya (DB-008 §3.2)
create policy file_object_read_authorization on file_object for select to app_authenticated
  using (organization_id = (select app.current_org()) and deleted_at is null and purpose = 'AUTHORIZATION_DOCUMENT'
         and exists (select 1 from worker_authorization wa where wa.file_id = file_object.id));

-- ---------------------------------------------------------------- 3. audit (API-006 §9)
create function app.audit_worker_authorization() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_new jsonb := to_jsonb(new) - 'updated_at' - 'version';
  v_old jsonb;
  v_fields text[];
  v_changes jsonb;
  v_action text;
begin
  if tg_op = 'INSERT' then
    select array_agg(k order by k) into v_fields from jsonb_object_keys(v_new) k where k not in ('id', 'organization_id', 'created_at');
    perform app.audit_enqueue(new.organization_id, 'authorization.create', 'worker_authorization', new.id, v_fields,
      v_new - 'id' - 'organization_id' - 'created_at', 'authorization.update', new.site_id);
    return null;
  end if;
  v_old := to_jsonb(old) - 'updated_at' - 'version';
  select array_agg(k order by k), jsonb_object_agg(k, jsonb_build_object('from', v_old->k, 'to', v_new->k))
  into v_fields, v_changes from jsonb_object_keys(v_new) k where v_new->k is distinct from v_old->k;
  if v_fields is null then return null; end if;
  v_action := case
    when new.suspension_status = 'SUSPENDED' and old.suspension_status = 'NONE' then 'authorization.suspend'
    when new.suspension_status = 'REVOKED' then 'authorization.revoke'
    when new.suspension_status = 'NONE' and old.suspension_status = 'SUSPENDED' then 'authorization.reinstate'
    when new.verification_status = 'VERIFIED' and old.verification_status = 'PENDING' then 'authorization.verify'
    when new.verification_status = 'REJECTED' and old.verification_status = 'PENDING' then 'authorization.reject'
    when new.verification_status = 'PENDING' and old.verification_status <> 'PENDING' then 'authorization.resubmit'
    else 'authorization.update' end;
  perform app.audit_enqueue(new.organization_id, v_action, 'worker_authorization', new.id, v_fields, v_changes,
    case when v_action in ('authorization.create', 'authorization.update', 'authorization.resubmit') then 'authorization.update'
         else 'authorization.verify' end,
    new.site_id);
  return null;
end $$;
revoke execute on function app.audit_worker_authorization() from public;
create trigger audit_worker_authorization after insert or update on worker_authorization
  for each row execute function app.audit_worker_authorization();

-- 0018_simper.sql: SIMPER (WF006, API-007, DB-003 §2.1/§2.2/§6).
-- - simper_type: master, dikelola readiness_profile.manage.
-- - simper: milik satu pekerja; verifikasi dengan pemisahan tugas; pembekuan NONE/SUSPENDED/REVOKED (akhir) hanya oleh
--   simper.verify penuh dengan alasan; data inti berubah pada VERIFIED/REJECTED -> PENDING; dokumen CLEAN milik pengunggah.
--   Pola sama dengan worker_authorization (0017).
-- - simper_authorization: otorisasi per kelas alat (bukan unit kendaraan/alat, BR-WF006-005). Status ACTIVE/SUSPENDED/
--   REVOKED (akhir) oleh simper.verify penuh dengan alasan. Tanggal dalam masa berlaku SIMPER induk. Satu otorisasi
--   tidak dicabut per kelas alat per SIMPER. Menambah/mengubah otorisasi pada SIMPER terverifikasi -> SIMPER PENDING.

-- ---------------------------------------------------------------- 1. master jenis SIMPER
create table simper_type (
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
  constraint simper_type_org_uq unique (id, organization_id)
);
create unique index simper_type_code_uq on simper_type (organization_id, code) where status = 'ACTIVE';
alter table simper_type enable row level security;
alter table simper_type force row level security;
revoke all on simper_type from public;
grant select, insert, update on simper_type to app_authenticated;
create policy simper_type_read on simper_type for select to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_any_scope('organization.read')) or (select app.has_self_permission('simper.update'))));
create policy simper_type_insert on simper_type for insert to app_authenticated
  with check (organization_id = (select app.current_org()) and (select app.has_org_wide('readiness_profile.manage')));
create policy simper_type_update on simper_type for update to app_authenticated
  using (organization_id = (select app.current_org()) and (select app.has_org_wide('readiness_profile.manage')))
  with check (organization_id = (select app.current_org()));
create trigger simper_type_version before update on simper_type for each row execute function app.bump_version();
create trigger audit_simper_type after insert or update on simper_type
  for each row execute function app.audit_structure_change('simper_type', 'readiness_profile.manage');

-- ---------------------------------------------------------------- 2. SIMPER milik pekerja
create table simper (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null,
  site_id               uuid not null,
  worker_id             uuid not null,
  simper_type_id uuid not null,
  simper_number  text check (length(simper_number) <= 100),
  issuer                text check (length(issuer) <= 150),
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
  foreign key (simper_type_id, organization_id) references simper_type (id, organization_id),
  foreign key (file_id, organization_id) references file_object (id, organization_id),
  constraint simper_org_uq unique (id, organization_id),
  constraint simper_range_chk check (valid_until is null or valid_until >= valid_from),
  constraint simper_sod_chk check (verified_by is null or verified_by <> created_by),
  constraint simper_verified_chk check (verification_status <> 'VERIFIED' or (verified_by is not null and verified_at is not null)),
  constraint simper_rejected_chk check (verification_status <> 'REJECTED'
                                                      or (verified_by is not null and length(btrim(coalesce(rejection_reason, ''))) > 0)),
  -- DB-003 §2.2: pembekuan/pencabutan beralasan dan tercatat pelakunya
  constraint simper_suspension_chk check (suspension_status = 'NONE'
                                                        or (length(btrim(coalesce(suspension_reason, ''))) > 0
                                                            and suspended_by is not null and suspended_at is not null))
);
create index simper_worker_idx on simper (worker_id, simper_type_id);
create index simper_queue_idx on simper (organization_id, verification_status, updated_at)
  where verification_status = 'PENDING';
create unique index simper_file_uq on simper (file_id) where file_id is not null;

-- Aturan status (BR-WF006-014..016):
-- - data inti berubah pada VERIFIED/REJECTED -> PENDING; verifikasi/penolakan hanya dari PENDING
-- - REVOKED akhir: tidak ada perubahan apa pun setelahnya
-- - transisi pembekuan sah saja, hanya oleh simper.verify penuh di Site record (bukan pekerja, bukan HSE Officer)
-- - berkas dokumen wajib CLEAN, bertujuan AUTHORIZATION_DOCUMENT, diunggah pemanggil
create function app.simper_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.file_id is not null and (tg_op = 'INSERT' or new.file_id is distinct from old.file_id) and not exists (
       select 1 from file_object f where f.id = new.file_id and f.organization_id = new.organization_id
         and f.scan_status = 'CLEAN' and f.purpose = 'SIMPER_DOCUMENT' and f.deleted_at is null
         -- berkas milik pemanggil (tidak dapat menempelkan berkas orang lain dengan menebak id)
         and (app.current_user_id() is null or f.uploaded_by = app.current_user_id())) then
    raise exception 'FILE_NOT_CLEAN: berkas belum lolos pemeriksaan atau bukan dokumen SIMPER' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if new.suspension_status <> 'NONE' and app.current_user_id() is not null then
      raise exception 'INVALID_STATE_TRANSITION: record baru tidak dapat dibekukan' using errcode = '23514';
    end if;
    return new;
  end if;
  if old.suspension_status = 'REVOKED' then
    raise exception 'INVALID_STATE_TRANSITION: SIMPER dicabut bersifat akhir' using errcode = '23514';
  end if;
  if new.suspension_status is distinct from old.suspension_status then
    if not ((old.suspension_status = 'NONE' and new.suspension_status in ('SUSPENDED', 'REVOKED'))
            or (old.suspension_status = 'SUSPENDED' and new.suspension_status in ('NONE', 'REVOKED'))) then
      raise exception 'INVALID_STATE_TRANSITION: transisi pembekuan tidak sah' using errcode = '23514';
    end if;
    -- pengguna aplikasi: wajib simper.verify penuh di Site record dan tercatat sebagai pelaku
    if app.current_user_id() is not null
       and (not app.has_permission('simper.verify', new.site_id) or new.suspended_by is distinct from app.current_user_id()) then
      raise exception 'pembekuan hanya oleh pemegang simper.verify penuh' using errcode = '42501';
    end if;
    if new.suspension_status = 'NONE' then
      new.suspended_by := null;
      new.suspended_at := null;
    end if;
  elsif (new.suspended_by, new.suspended_at, new.suspension_reason)
        is distinct from (old.suspended_by, old.suspended_at, old.suspension_reason) then
    raise exception 'INVALID_STATE_TRANSITION: kolom pembekuan hanya berubah lewat aksi pembekuan' using errcode = '23514';
  end if;
  if (new.simper_type_id, new.simper_number, new.issuer, new.restriction_note,
      new.valid_from, new.valid_until, new.file_id)
     is distinct from (old.simper_type_id, old.simper_number, old.issuer, old.restriction_note,
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
  -- otorisasi kelas alat ACTIVE tetap dalam masa berlaku SIMPER induk (BR-WF006-016)
  if (new.valid_from, new.valid_until) is distinct from (old.valid_from, old.valid_until) and exists (
       select 1 from simper_authorization a where a.simper_id = new.id and a.status <> 'REVOKED'
         and (a.valid_from < new.valid_from
              or (new.valid_until is not null and (a.valid_until is null or a.valid_until > new.valid_until)))) then
    raise exception 'AUTHORIZATION_OUTSIDE_SIMPER_VALIDITY: otorisasi kelas alat di luar masa berlaku SIMPER baru'
      using errcode = '23514';
  end if;
  return new;
end $$;
revoke execute on function app.simper_guard() from public;
create trigger simper_guard before insert or update on simper
  for each row execute function app.simper_guard();
create trigger simper_version before update on simper for each row execute function app.bump_version();

alter table simper enable row level security;
alter table simper force row level security;
revoke all on simper from public;
grant select, insert on simper to app_authenticated;
grant update (simper_type_id, simper_number, issuer, restriction_note, valid_from, valid_until, file_id,
              verification_status, verified_by, verified_at, verification_comment, rejection_reason,
              suspension_status, suspended_by, suspended_at, suspension_reason) on simper to app_authenticated;
create policy simper_read on simper for select to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('simper.read'))
              or site_id = any ((select app.permitted_sites('simper.read'))::uuid[])
              or worker_id = any ((select app.permitted_team_workers('simper.read'))::uuid[])
              or worker_id in (select w.id from worker w
                               where w.contractor_id = any ((select app.permitted_contractors('simper.read'))::uuid[]))
              or worker_id = (select app.my_worker_id())));
create policy simper_insert on simper for insert to app_authenticated
  with check (organization_id = (select app.current_org()) and created_by = (select app.current_user_id())
              and verification_status = 'PENDING' and verified_by is null and suspension_status = 'NONE'
              and ((select app.has_org_wide('simper.update'))
                   or site_id = any ((select app.permitted_sites('simper.update'))::uuid[])
                   or (worker_id = (select app.my_worker_id()) and (select app.has_self_permission('simper.update')))));
create policy simper_update on simper for update to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('simper.update'))
              or site_id = any ((select app.permitted_sites('simper.update'))::uuid[])
              or (select app.has_org_wide('simper.verify'))
              or site_id = any ((select app.permitted_sites('simper.verify'))::uuid[])
              or (worker_id = (select app.my_worker_id()) and (select app.has_self_permission('simper.update')))))
  with check (organization_id = (select app.current_org())
              and (verification_status = 'PENDING'
                   or (verified_by = (select app.current_user_id())
                       and ((select app.has_org_wide('simper.verify'))
                            or site_id = any ((select app.permitted_sites('simper.verify'))::uuid[])))
                   -- pembekuan record terverifikasi oleh orang lain: diperiksa pemicu (simper.verify penuh)
                   or suspended_by = (select app.current_user_id())));

-- dokumen SIMPER terlihat oleh yang dapat melihat record pemiliknya (DB-008 §3.2)
create policy file_object_read_simper on file_object for select to app_authenticated
  using (organization_id = (select app.current_org()) and deleted_at is null and purpose = 'SIMPER_DOCUMENT'
         and exists (select 1 from simper s where s.file_id = file_object.id));


-- ---------------------------------------------------------------- 3. otorisasi per kelas alat
create table simper_authorization (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null,
  simper_id          uuid not null,
  equipment_class_id uuid not null,
  valid_from         date not null,
  valid_until        date,
  restriction_note   text check (length(restriction_note) <= 500),
  status             text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUSPENDED', 'REVOKED')),
  status_reason      text check (length(status_reason) <= 500),
  status_changed_by  uuid references user_profile (id),
  status_changed_at  timestamptz,
  created_by         uuid not null references user_profile (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  version            integer not null default 1,
  foreign key (simper_id, organization_id) references simper (id, organization_id),
  foreign key (equipment_class_id, organization_id) references equipment_class (id, organization_id),
  constraint simper_authorization_range_chk check (valid_until is null or valid_until >= valid_from),
  constraint simper_authorization_status_chk check (status = 'ACTIVE'
                                                    or (length(btrim(coalesce(status_reason, ''))) > 0
                                                        and status_changed_by is not null and status_changed_at is not null))
);
create unique index simper_authorization_class_uq on simper_authorization (simper_id, equipment_class_id) where status <> 'REVOKED';
create index simper_authorization_simper_idx on simper_authorization (simper_id);

create function app.simper_authorization_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p simper%rowtype;
begin
  select * into p from simper where id = new.simper_id;
  if p.suspension_status = 'REVOKED' then
    raise exception 'INVALID_STATE_TRANSITION: SIMPER dicabut bersifat akhir' using errcode = '23514';
  end if;
  if new.valid_from < p.valid_from
     or (p.valid_until is not null and (new.valid_until is null or new.valid_until > p.valid_until)) then
    raise exception 'AUTHORIZATION_OUTSIDE_SIMPER_VALIDITY: otorisasi kelas alat di luar masa berlaku SIMPER' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'ACTIVE' and app.current_user_id() is not null then
      raise exception 'INVALID_STATE_TRANSITION: otorisasi baru harus ACTIVE' using errcode = '23514';
    end if;
  else
    if old.status = 'REVOKED' then
      raise exception 'INVALID_STATE_TRANSITION: otorisasi kelas alat dicabut bersifat akhir' using errcode = '23514';
    end if;
    if new.equipment_class_id is distinct from old.equipment_class_id then
      raise exception 'INVALID_STATE_TRANSITION: kelas alat tidak dapat diganti, cabut lalu buat baru' using errcode = '23514';
    end if;
    if new.status is distinct from old.status then
      if not ((old.status = 'ACTIVE' and new.status in ('SUSPENDED', 'REVOKED'))
              or (old.status = 'SUSPENDED' and new.status in ('ACTIVE', 'REVOKED'))) then
        raise exception 'INVALID_STATE_TRANSITION: transisi status otorisasi kelas alat tidak sah' using errcode = '23514';
      end if;
      if app.current_user_id() is not null
         and (not app.has_permission('simper.verify', p.site_id) or new.status_changed_by is distinct from app.current_user_id()) then
        raise exception 'pembekuan hanya oleh pemegang simper.verify penuh' using errcode = '42501';
      end if;
      if new.status = 'ACTIVE' then
        new.status_changed_by := null;
        new.status_changed_at := null;
      end if;
      return new;
    elsif (new.status_reason, new.status_changed_by, new.status_changed_at)
          is distinct from (old.status_reason, old.status_changed_by, old.status_changed_at) then
      raise exception 'INVALID_STATE_TRANSITION: kolom status hanya berubah lewat aksi pembekuan' using errcode = '23514';
    end if;
  end if;
  -- data inti otorisasi (baru/diubah) pada SIMPER terverifikasi/ditolak -> SIMPER kembali PENDING (WR-004)
  update simper set verification_status = 'PENDING', verified_by = null, verified_at = null,
         verification_comment = null, rejection_reason = null
   where id = new.simper_id and verification_status <> 'PENDING';
  return new;
end $$;
revoke execute on function app.simper_authorization_guard() from public;
create trigger simper_authorization_guard before insert or update on simper_authorization
  for each row execute function app.simper_authorization_guard();
create trigger simper_authorization_version before update on simper_authorization for each row execute function app.bump_version();

alter table simper_authorization enable row level security;
alter table simper_authorization force row level security;
revoke all on simper_authorization from public;
grant select, insert on simper_authorization to app_authenticated;
grant update (valid_from, valid_until, restriction_note, status, status_reason, status_changed_by, status_changed_at)
  on simper_authorization to app_authenticated;
-- terlihat bila SIMPER induk terlihat (RLS simper)
create policy simper_authorization_read on simper_authorization for select to app_authenticated
  using (organization_id = (select app.current_org()) and exists (select 1 from simper s where s.id = simper_id));
create policy simper_authorization_insert on simper_authorization for insert to app_authenticated
  with check (organization_id = (select app.current_org()) and created_by = (select app.current_user_id()) and status = 'ACTIVE'
              and exists (select 1 from simper s where s.id = simper_id
                          and ((select app.has_org_wide('simper.update'))
                               or s.site_id = any ((select app.permitted_sites('simper.update'))::uuid[])
                               or (s.worker_id = (select app.my_worker_id()) and (select app.has_self_permission('simper.update'))))));
-- ubah data: pemegang simper.update atas induk; ubah status: diperiksa pemicu (simper.verify penuh)
create policy simper_authorization_update on simper_authorization for update to app_authenticated
  using (organization_id = (select app.current_org())
         and exists (select 1 from simper s where s.id = simper_id
                     and ((select app.has_org_wide('simper.update')) or (select app.has_org_wide('simper.verify'))
                          or s.site_id = any ((select app.permitted_sites('simper.update'))::uuid[])
                          or s.site_id = any ((select app.permitted_sites('simper.verify'))::uuid[])
                          or (s.worker_id = (select app.my_worker_id()) and (select app.has_self_permission('simper.update'))))))
  with check (organization_id = (select app.current_org()));

create function app.audit_simper_authorization() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_new jsonb := to_jsonb(new) - 'updated_at' - 'version';
  v_old jsonb;
  v_fields text[];
  v_changes jsonb;
  v_action text;
  v_site uuid := (select site_id from simper where id = new.simper_id);
begin
  if tg_op = 'INSERT' then
    select array_agg(k order by k) into v_fields from jsonb_object_keys(v_new) k where k not in ('id', 'organization_id', 'created_at');
    perform app.audit_enqueue(new.organization_id, 'simper_authorization.create', 'simper_authorization', new.id, v_fields,
      v_new - 'id' - 'organization_id' - 'created_at', 'simper.update', v_site);
    return null;
  end if;
  v_old := to_jsonb(old) - 'updated_at' - 'version';
  select array_agg(k order by k), jsonb_object_agg(k, jsonb_build_object('from', v_old->k, 'to', v_new->k))
  into v_fields, v_changes from jsonb_object_keys(v_new) k where v_new->k is distinct from v_old->k;
  if v_fields is null then return null; end if;
  v_action := case
    when new.status = 'SUSPENDED' and old.status = 'ACTIVE' then 'simper_authorization.suspend'
    when new.status = 'REVOKED' then 'simper_authorization.revoke'
    when new.status = 'ACTIVE' and old.status = 'SUSPENDED' then 'simper_authorization.reinstate'
    else 'simper_authorization.update' end;
  perform app.audit_enqueue(new.organization_id, v_action, 'simper_authorization', new.id, v_fields, v_changes,
    case when v_action = 'simper_authorization.update' then 'simper.update' else 'simper.verify' end, v_site);
  return null;
end $$;
revoke execute on function app.audit_simper_authorization() from public;
create trigger audit_simper_authorization after insert or update on simper_authorization
  for each row execute function app.audit_simper_authorization();

-- ---------------------------------------------------------------- 4. audit SIMPER (API-007 §9)
create function app.audit_simper() returns trigger
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
    perform app.audit_enqueue(new.organization_id, 'simper.create', 'simper', new.id, v_fields,
      v_new - 'id' - 'organization_id' - 'created_at', 'simper.update', new.site_id);
    return null;
  end if;
  v_old := to_jsonb(old) - 'updated_at' - 'version';
  select array_agg(k order by k), jsonb_object_agg(k, jsonb_build_object('from', v_old->k, 'to', v_new->k))
  into v_fields, v_changes from jsonb_object_keys(v_new) k where v_new->k is distinct from v_old->k;
  if v_fields is null then return null; end if;
  v_action := case
    when new.suspension_status = 'SUSPENDED' and old.suspension_status = 'NONE' then 'simper.suspend'
    when new.suspension_status = 'REVOKED' then 'simper.revoke'
    when new.suspension_status = 'NONE' and old.suspension_status = 'SUSPENDED' then 'simper.reinstate'
    when new.verification_status = 'VERIFIED' and old.verification_status = 'PENDING' then 'simper.verify'
    when new.verification_status = 'REJECTED' and old.verification_status = 'PENDING' then 'simper.reject'
    when new.verification_status = 'PENDING' and old.verification_status <> 'PENDING' then 'simper.resubmit'
    else 'simper.update' end;
  perform app.audit_enqueue(new.organization_id, v_action, 'simper', new.id, v_fields, v_changes,
    case when v_action in ('simper.create', 'simper.update', 'simper.resubmit') then 'simper.update'
         else 'simper.verify' end,
    new.site_id);
  return null;
end $$;
revoke execute on function app.audit_simper() from public;
create trigger audit_simper after insert or update on simper
  for each row execute function app.audit_simper();

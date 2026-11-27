-- 0023_readiness_engine.sql: M4.1 Requirement Profile dan Workforce Readiness Engine (SRS-RE v1.2.1, DB-005 v2.1.0,
-- PRD-RE, B-02, B-03, B-12, B-27, B-30).
-- Engine deterministik, dapat dijelaskan dan diaudit; tanpa AI. Status READY / CONDITIONAL / NOT_READY ditentukan
-- Requirement (B-02), skor hanya informatif.
--
-- Isi:
-- 0. Bersihkan tabel spike M0 (requirement_item, competency_record, medical_status, medical_detail, readiness_snapshot lama).
-- 1. requirement_profile (berversi: DRAFT -> ACTIVE -> ARCHIVED, satu ACTIVE per Job Position) dan requirement_profile_item.
-- 2. readiness_snapshot dan readiness_snapshot_item (append-only), readiness_current, readiness_outbox.
-- 3. app.readiness_evaluate(): algoritma SRS-RE 6.1-6.7 (Rule Version RE-1).
-- 4. Pemicu: trigger outbox transaksional pada worker dan modul sumber; app.readiness_process() (tiap menit, debounce
--    5 detik); app.readiness_evaluate_due() (tiap jam, next_evaluation_at + pekerja yang belum pernah dievaluasi);
--    app.readiness_evaluate_manual() (readiness.evaluate, teraudit).
-- 5. Pembacaan: RLS readiness.read sesuai scope; item lewat app.readiness_items() dengan penyamaran medis (SRS-RE 10).
--
-- Penetapan rincian (B-30): item TRAINING belum diterima sampai modul Training (P3); MEDICAL memakai MCU terverifikasi
-- terbaru jenis itu (bukan "terbaik", agar UNFIT terbaru tidak tertutup FIT lama); FIT_WITH_CONDITION = VALID;
-- pembekuan aktif = record berstatus SUSPENDED yang masa berlakunya belum habis; input_hash dihitung dari hasil per item
-- (tanpa tanggal) sehingga snapshot hanya dibuat saat hasil berubah; nomor versi profile di kolom profile_version
-- (kolom version dipakai optimistic locking seperti tabel lain); weight_override disimpan tetapi belum dipakai skor;
-- snapshot belum dipartisi (dipartisi saat volume membutuhkan); notifikasi perubahan status menyusul (M4.4).

-- ---------------------------------------------------------------- 0. spike M0
drop table readiness_snapshot;
drop table competency_record;
drop table medical_status;
drop table medical_detail;
drop table requirement_item;

-- perbaikan 0022: penugasan peran yang belum/sudah tidak berlaku tidak ikut menerima notifikasi
create or replace function app.notification_staff(p_org uuid, p_site uuid, p_roles text[]) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct ura.user_id), '{}'::uuid[])
  from user_role_assignment ura
  join user_profile up on up.id = ura.user_id and up.status = 'ACTIVE' and up.organization_id = p_org
  where ura.organization_id = p_org and ura.revoked_at is null and ura.role_code = any (p_roles)
    and ura.valid_from <= now() and (ura.valid_until is null or ura.valid_until > now())
    and (ura.scope_type = 'ORGANIZATION' or (ura.scope_type = 'SITE' and ura.scope_id = p_site))
$$;

-- ---------------------------------------------------------------- 1. Requirement Profile
create table requirement_profile (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organization (id),
  job_position_id  uuid not null,
  profile_version  integer not null check (profile_version >= 1),
  status           text not null default 'DRAFT' check (status in ('DRAFT', 'ACTIVE', 'ARCHIVED')),
  effective_from   date,
  notes            text check (length(notes) <= 1000),
  activated_by     uuid references user_profile (id),
  activated_at     timestamptz,
  created_by       uuid references user_profile (id),
  version          integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (job_position_id, organization_id) references job_position (id, organization_id),
  constraint requirement_profile_org_uq unique (id, organization_id),
  constraint requirement_profile_version_uq unique (job_position_id, profile_version),
  constraint requirement_profile_activation_chk check (status <> 'ACTIVE' or activated_at is not null)
);
create unique index requirement_profile_active_uq on requirement_profile (job_position_id) where status = 'ACTIVE';

create table requirement_profile_item (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null,
  profile_id             uuid not null,
  item_type              text not null check (item_type in ('COMPETENCY', 'MEDICAL', 'AUTHORIZATION', 'SIMPER')),
  competency_id          uuid,
  medical_exam_type_id   uuid,
  authorization_type_id  uuid,
  simper_type_id         uuid,
  equipment_class_id     uuid,
  is_mandatory           boolean not null default true,
  warning_days           integer not null default 30 check (warning_days between 0 and 365),
  weight_override        numeric(6, 2) check (weight_override is null or weight_override > 0),
  display_order          integer not null default 0,
  created_at             timestamptz not null default now(),
  foreign key (profile_id, organization_id) references requirement_profile (id, organization_id) on delete cascade,
  foreign key (competency_id, organization_id) references competency (id, organization_id),
  foreign key (medical_exam_type_id, organization_id) references medical_exam_type (id, organization_id),
  foreign key (authorization_type_id, organization_id) references authorization_type (id, organization_id),
  foreign key (simper_type_id, organization_id) references simper_type (id, organization_id),
  foreign key (equipment_class_id, organization_id) references equipment_class (id, organization_id),
  constraint requirement_profile_item_ref_chk check (case item_type
    when 'COMPETENCY' then competency_id is not null and medical_exam_type_id is null and authorization_type_id is null
                           and simper_type_id is null
    when 'MEDICAL' then medical_exam_type_id is not null and competency_id is null and authorization_type_id is null
                        and simper_type_id is null
    when 'AUTHORIZATION' then authorization_type_id is not null and competency_id is null and medical_exam_type_id is null
                              and simper_type_id is null
    when 'SIMPER' then simper_type_id is not null and competency_id is null and medical_exam_type_id is null
                       and authorization_type_id is null
    else false end),
  constraint requirement_profile_item_class_chk check (equipment_class_id is null or item_type = 'SIMPER')
);
create unique index requirement_profile_item_requirement_uq on requirement_profile_item
  (profile_id, item_type, competency_id, medical_exam_type_id, authorization_type_id, simper_type_id, equipment_class_id)
  nulls not distinct;
create index requirement_profile_item_profile_idx on requirement_profile_item (profile_id, display_order);

-- master dengan kunci gabungan untuk FK (id, organization_id) yang belum memilikinya
do $$
declare t text;
begin
  foreach t in array array['competency', 'medical_exam_type', 'authorization_type', 'simper_type', 'equipment_class', 'job_position'] loop
    if not exists (select 1 from pg_constraint c join pg_class r on r.oid = c.conrelid
                   where r.relname = t and c.contype in ('u', 'p')
                     and (select array_agg(a.attname::text order by a.attname) from unnest(c.conkey) k
                          join pg_attribute a on a.attrelid = r.oid and a.attnum = k) = array['id', 'organization_id']) then
      raise exception 'master % tidak memiliki kunci unik (id, organization_id)', t;
    end if;
  end loop;
end $$;

-- profile ACTIVE/ARCHIVED tidak dapat diubah; aktivasi mengarsipkan versi aktif sebelumnya dan memicu evaluasi
create function app.requirement_profile_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'DRAFT' then
      raise exception 'INVALID_STATE_TRANSITION: profile baru selalu DRAFT' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.job_position_id, new.profile_version, new.organization_id) is distinct from (old.job_position_id, old.profile_version, old.organization_id) then
    raise exception 'INVALID_STATE_TRANSITION: posisi dan nomor versi profile tidak dapat diubah' using errcode = '23514';
  end if;
  if old.status <> 'DRAFT' and (new.effective_from, new.notes) is distinct from (old.effective_from, old.notes) then
    raise exception 'PROFILE_LOCKED: profile aktif atau arsip tidak dapat diubah, buat versi baru' using errcode = '23514';
  end if;
  if new.status is distinct from old.status then
    if not ((old.status = 'DRAFT' and new.status in ('ACTIVE', 'ARCHIVED')) or (old.status = 'ACTIVE' and new.status = 'ARCHIVED')) then
      raise exception 'INVALID_STATE_TRANSITION: % -> %', old.status, new.status using errcode = '23514';
    end if;
    if new.status = 'ACTIVE' then
      if not exists (select 1 from requirement_profile_item i where i.profile_id = new.id) then
        raise exception 'PROFILE_EMPTY: profile tanpa syarat tidak dapat diaktifkan' using errcode = '23514';
      end if;
      new.activated_at := now();
      new.activated_by := app.current_user_id();
      update requirement_profile set status = 'ARCHIVED'
       where job_position_id = new.job_position_id and status = 'ACTIVE' and id <> new.id;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke execute on function app.requirement_profile_guard() from public;
create trigger requirement_profile_guard before insert or update on requirement_profile
  for each row execute function app.requirement_profile_guard();
create trigger requirement_profile_version before update on requirement_profile
  for each row execute function app.bump_version();

create function app.requirement_profile_item_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_status text;
begin
  select status into v_status from requirement_profile where id = coalesce(new.profile_id, old.profile_id);
  -- penghapusan berantai saat profile DRAFT dihapus tetap diizinkan (induk sudah tidak ada)
  if v_status is not null and v_status <> 'DRAFT' then
    raise exception 'PROFILE_LOCKED: syarat hanya dapat diubah pada profile DRAFT' using errcode = '23514';
  end if;
  return coalesce(new, old);
end $$;
revoke execute on function app.requirement_profile_item_guard() from public;
create trigger requirement_profile_item_guard before insert or update or delete on requirement_profile_item
  for each row execute function app.requirement_profile_item_guard();

alter table requirement_profile enable row level security;
alter table requirement_profile force row level security;
alter table requirement_profile_item enable row level security;
alter table requirement_profile_item force row level security;
revoke all on requirement_profile, requirement_profile_item from public;
grant select, insert, update, delete on requirement_profile to app_authenticated;
grant select, insert, update, delete on requirement_profile_item to app_authenticated;
create policy requirement_profile_read on requirement_profile for select to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_any_scope('readiness.read')) or (select app.has_any_scope('readiness_profile.manage'))
              or (select app.has_any_scope('organization.read'))));
create policy requirement_profile_insert on requirement_profile for insert to app_authenticated
  with check (organization_id = (select app.current_org()) and (select app.has_org_wide('readiness_profile.manage')));
create policy requirement_profile_update on requirement_profile for update to app_authenticated
  using (organization_id = (select app.current_org()) and (select app.has_org_wide('readiness_profile.manage')))
  with check (organization_id = (select app.current_org()));
create policy requirement_profile_delete on requirement_profile for delete to app_authenticated
  using (organization_id = (select app.current_org()) and status = 'DRAFT'
         and (select app.has_org_wide('readiness_profile.manage')));
create policy requirement_profile_item_read on requirement_profile_item for select to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_any_scope('readiness.read')) or (select app.has_any_scope('readiness_profile.manage'))
              or (select app.has_any_scope('organization.read'))));
create policy requirement_profile_item_write on requirement_profile_item for all to app_authenticated
  using (organization_id = (select app.current_org()) and (select app.has_org_wide('readiness_profile.manage')))
  with check (organization_id = (select app.current_org()) and (select app.has_org_wide('readiness_profile.manage')));

create trigger audit_requirement_profile after insert or update on requirement_profile
  for each row execute function app.audit_structure_change('requirement_profile', 'readiness_profile.manage');
create function app.audit_requirement_profile_item() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r requirement_profile_item%rowtype := coalesce(new, old);
  v jsonb := to_jsonb(r) - 'organization_id' - 'created_at';
begin
  perform app.audit_enqueue(r.organization_id,
    'requirement_profile.' || case tg_op when 'INSERT' then 'item_add' when 'DELETE' then 'item_remove' else 'item_update' end,
    'requirement_profile', r.profile_id, array(select k from jsonb_object_keys(v) k order by k), v,
    'readiness_profile.manage', null);
  return null;
end $$;
revoke execute on function app.audit_requirement_profile_item() from public;
create trigger audit_requirement_profile_item after insert or update or delete on requirement_profile_item
  for each row execute function app.audit_requirement_profile_item();

-- ---------------------------------------------------------------- 2. hasil evaluasi
create table readiness_snapshot (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organization (id),
  worker_id        uuid not null references worker (id),
  site_id          uuid not null,
  status           text not null check (status in ('READY', 'CONDITIONAL', 'NOT_READY')),
  previous_status  text check (previous_status in ('READY', 'CONDITIONAL', 'NOT_READY')),
  score            smallint not null check (score between 0 and 100),
  reason_code      text check (reason_code in ('WORKER_INACTIVE', 'PROFILE_NOT_SET')),
  profile_id       uuid references requirement_profile (id),
  profile_version  integer,
  rule_version     text not null,
  input_hash       text not null,
  trigger_type     text not null check (trigger_type in ('EVENT', 'SCHEDULED', 'MANUAL', 'PROFILE_CHANGE', 'RULE_CHANGE')),
  triggered_by     uuid references user_profile (id),
  evaluated_at     timestamptz not null default now()
);
create index readiness_snapshot_worker_idx on readiness_snapshot (organization_id, worker_id, evaluated_at desc);

create table readiness_snapshot_item (
  id                  uuid primary key default gen_random_uuid(),
  snapshot_id         uuid not null references readiness_snapshot (id),
  profile_item_id     uuid not null references requirement_profile_item (id),
  item_type           text not null,
  item_name           text,
  requirement_status  text not null check (requirement_status in
                        ('VALID', 'EXPIRING_SOON', 'EXPIRED', 'MISSING', 'PENDING_VERIFICATION', 'REJECTED', 'SUSPENDED', 'RESTRICTED')),
  is_mandatory        boolean not null,
  source_record_type  text check (source_record_type in ('worker_competency', 'medical_record', 'worker_authorization', 'simper')),
  source_record_id    uuid,
  expiry_date         date,
  reason_code         text not null,
  is_sensitive        boolean not null default false
);
create index readiness_snapshot_item_snapshot_idx on readiness_snapshot_item (snapshot_id);

create table readiness_current (
  worker_id           uuid primary key references worker (id),
  organization_id     uuid not null references organization (id),
  site_id             uuid not null,
  snapshot_id         uuid not null references readiness_snapshot (id),
  status              text not null,
  score               smallint not null,
  input_hash          text not null,
  evaluated_at        timestamptz not null,
  next_evaluation_at  timestamptz,
  version             integer not null default 1
);
create index readiness_current_status_idx on readiness_current (organization_id, status);
create index readiness_current_due_idx on readiness_current (next_evaluation_at) where next_evaluation_at is not null;

create table readiness_outbox (
  id               bigserial primary key,
  organization_id  uuid not null,
  worker_id        uuid,
  event_type       text not null check (event_type in ('WORKER_CHANGED', 'RECORD_CHANGED', 'PROFILE_ACTIVATED', 'MANUAL_REQUEST')),
  payload          jsonb not null default '{}'::jsonb,
  status           text not null default 'PENDING' check (status in ('PENDING', 'DONE', 'FAILED')),
  attempts         integer not null default 0,
  last_error       text,
  created_at       timestamptz not null default now(),
  processed_at     timestamptz
);
create index readiness_outbox_pending_idx on readiness_outbox (created_at) where status in ('PENDING', 'FAILED');

-- append-only: tidak ada peran yang dapat mengubah atau menghapus snapshot (BR-RE-004, BR-RE-010)
create function app.readiness_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'APPEND_ONLY: % tidak dapat diubah atau dihapus', tg_table_name using errcode = '42501';
end $$;
create trigger readiness_snapshot_append_only before update or delete on readiness_snapshot
  for each row execute function app.readiness_append_only();
create trigger readiness_snapshot_item_append_only before update or delete on readiness_snapshot_item
  for each row execute function app.readiness_append_only();

alter table readiness_snapshot enable row level security;
alter table readiness_snapshot force row level security;
alter table readiness_snapshot_item enable row level security;
alter table readiness_snapshot_item force row level security;
alter table readiness_current enable row level security;
alter table readiness_current force row level security;
alter table readiness_outbox enable row level security;
alter table readiness_outbox force row level security;
revoke all on readiness_snapshot, readiness_snapshot_item, readiness_current, readiness_outbox from public;
-- tulis hanya lewat fungsi engine (security definer); item hanya lewat app.readiness_items (penyamaran)
grant select on readiness_snapshot, readiness_current to app_authenticated;
-- antrean hanya ditulis/dibaca fungsi SECURITY DEFINER milik pemilik migrasi (pola 0008/0010)
create policy readiness_outbox_definer on readiness_outbox for all to current_user using (true) with check (true);
create policy readiness_snapshot_read on readiness_snapshot for select to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('readiness.read'))
              or site_id = any ((select app.permitted_sites('readiness.read'))::uuid[])
              or worker_id = any ((select app.permitted_team_workers('readiness.read'))::uuid[])
              or (worker_id = (select app.my_worker_id()) and (select app.has_self_permission('readiness.read')))));
create policy readiness_current_read on readiness_current for select to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('readiness.read'))
              or site_id = any ((select app.permitted_sites('readiness.read'))::uuid[])
              or worker_id = any ((select app.permitted_team_workers('readiness.read'))::uuid[])
              or (worker_id = (select app.my_worker_id()) and (select app.has_self_permission('readiness.read')))));

-- ---------------------------------------------------------------- 3. engine
-- Peringkat status record (SRS-RE 6.3): kecil = lebih baik. MISSING hanya dipakai saat menggabungkan SIMPER dan kelas alat.
create function app.readiness_rank(p_status text) returns integer
language sql immutable as $$
  select case p_status when 'VALID' then 1 when 'RESTRICTED' then 2 when 'EXPIRING_SOON' then 3
    when 'PENDING_VERIFICATION' then 4 when 'EXPIRED' then 5 when 'REJECTED' then 6 when 'SUSPENDED' then 7 else 8 end
$$;

-- Status satu record berdasarkan tanggal berakhir (SRS-RE 6.2, setelah pemeriksaan pembekuan/penolakan/medis)
create function app.readiness_date_status(p_verified boolean, p_expiry date, p_today date, p_warning int) returns text
language sql immutable as $$
  select case
    when p_expiry is not null and p_expiry < p_today then 'EXPIRED'
    when not p_verified then 'PENDING_VERIFICATION'
    when p_expiry is not null and p_expiry <= p_today + p_warning then 'EXPIRING_SOON'
    else 'VALID' end
$$;

-- Tanggal hasil berikutnya berubah (SRS-RE 6.7): awal masa peringatan (VALID -> EXPIRING_SOON) atau sehari setelah
-- berakhir (-> EXPIRED); hanya tanggal setelah hari ini yang dipertimbangkan.
create function app.readiness_next_date(p_cur date, p_expiry date, p_warning int, p_today date) returns date
language sql immutable as $$
  select least(p_cur,
               case when p_expiry - p_warning > p_today then p_expiry - p_warning end,
               case when p_expiry + 1 > p_today then p_expiry + 1 end)
$$;

-- Hasil satu item profile untuk satu pekerja
create function app.readiness_item_result(p_item requirement_profile_item, p_worker uuid, p_today date,
  out status text, out source_type text, out source_id uuid, out expiry date, out reason text, out sensitive boolean,
  out next_change date)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  r record;
  m record;
  v_best int := 99;
  v_rank int;
  v_status text;
  v_class text;
  v_class_expiry date;
begin
  sensitive := p_item.item_type = 'MEDICAL';
  next_change := null;
  if p_item.item_type = 'COMPETENCY' then
    for r in select wc.id, wc.verification_status, wc.valid_until from worker_competency wc
             where wc.worker_id = p_worker and wc.competency_id = p_item.competency_id loop
      v_status := case when r.verification_status = 'REJECTED' then 'REJECTED'
                       else app.readiness_date_status(r.verification_status = 'VERIFIED', r.valid_until, p_today, p_item.warning_days) end;
      if r.verification_status <> 'REJECTED' and r.valid_until is not null then
        next_change := app.readiness_next_date(next_change, r.valid_until, p_item.warning_days, p_today);
      end if;
      v_rank := app.readiness_rank(v_status);
      if v_rank < v_best then
        v_best := v_rank; status := v_status; source_type := 'worker_competency'; source_id := r.id; expiry := r.valid_until;
      end if;
    end loop;
  elsif p_item.item_type in ('AUTHORIZATION', 'SIMPER') then
    for r in
      select a.id, a.verification_status, a.valid_until, a.suspension_status from worker_authorization a
       where p_item.item_type = 'AUTHORIZATION' and a.worker_id = p_worker and a.authorization_type_id = p_item.authorization_type_id
      union all
      select s.id, s.verification_status, s.valid_until, s.suspension_status from simper s
       where p_item.item_type = 'SIMPER' and s.worker_id = p_worker and s.simper_type_id = p_item.simper_type_id
    loop
      -- pembekuan aktif pada requirement -> SUSPENDED (SRS-RE 6.3)
      if r.suspension_status = 'SUSPENDED' and (r.valid_until is null or r.valid_until >= p_today) then
        status := 'SUSPENDED'; reason := 'SUSPENDED';
        source_type := case p_item.item_type when 'SIMPER' then 'simper' else 'worker_authorization' end;
        source_id := r.id; expiry := r.valid_until;
        -- pembekuan berhenti berlaku setelah masa berlaku record habis
        next_change := case when r.valid_until is not null then r.valid_until + 1 end;
        return;
      end if;
      v_status := case when r.suspension_status in ('SUSPENDED', 'REVOKED') then 'SUSPENDED'
                       when r.verification_status = 'REJECTED' then 'REJECTED'
                       else app.readiness_date_status(r.verification_status = 'VERIFIED', r.valid_until, p_today, p_item.warning_days) end;
      -- SIMPER dengan kelas alat: kombinasi terburuk SIMPER induk dan otorisasi kelas alat (SRS-RE 6.3.1)
      if p_item.item_type = 'SIMPER' and p_item.equipment_class_id is not null and v_status in ('VALID', 'EXPIRING_SOON') then
        select case when sa.status <> 'ACTIVE' then 'SUSPENDED'
                    else app.readiness_date_status(true, sa.valid_until, p_today, p_item.warning_days) end, sa.valid_until
          into v_class, v_class_expiry
          from simper_authorization sa
         where sa.simper_id = r.id and sa.equipment_class_id = p_item.equipment_class_id and sa.valid_from <= p_today
         order by app.readiness_rank(case when sa.status <> 'ACTIVE' then 'SUSPENDED'
                    else app.readiness_date_status(true, sa.valid_until, p_today, p_item.warning_days) end), sa.valid_until desc nulls first
         limit 1;
        v_class := coalesce(v_class, 'MISSING');
        if app.readiness_rank(v_class) > app.readiness_rank(v_status) then
          v_status := case when v_class = 'MISSING' then 'MISSING' else v_class end;
        end if;
        if v_class_expiry is not null and v_class in ('VALID', 'EXPIRING_SOON') then
          next_change := app.readiness_next_date(next_change, v_class_expiry, p_item.warning_days, p_today);
        end if;
      end if;
      if r.suspension_status = 'NONE' and r.verification_status <> 'REJECTED' and r.valid_until is not null then
        next_change := app.readiness_next_date(next_change, r.valid_until, p_item.warning_days, p_today);
      end if;
      v_rank := app.readiness_rank(v_status);
      if v_rank < v_best then
        v_best := v_rank; status := v_status; expiry := r.valid_until; source_id := r.id;
        source_type := case p_item.item_type when 'SIMPER' then 'simper' else 'worker_authorization' end;
      end if;
    end loop;
  else
    -- MEDICAL (B-30): MCU terverifikasi terbaru jenis itu menentukan; tanpa record terverifikasi, PENDING/REJECTED/MISSING
    select mr.id, mr.fitness_status, mr.expiry_date into m from medical_record mr
     where mr.worker_id = p_worker and mr.exam_type_id = p_item.medical_exam_type_id and mr.verification_status = 'VERIFIED'
     order by mr.examination_date desc, mr.verified_at desc limit 1;
    if m.id is not null then
      source_type := 'medical_record'; source_id := m.id; expiry := m.expiry_date;
      if m.fitness_status = 'UNFIT' then
        status := 'SUSPENDED'; reason := 'MEDICAL_UNFIT';
      elsif m.expiry_date < p_today then
        status := 'EXPIRED';
      elsif m.fitness_status = 'FIT_WITH_RESTRICTION' and exists (
              select 1 from medical_restriction x where x.medical_record_id = m.id and x.status = 'ACTIVE'
                and x.valid_from <= p_today and (x.valid_until is null or x.valid_until >= p_today)) then
        status := 'RESTRICTED'; reason := 'MEDICAL_RESTRICTED';
      elsif m.expiry_date <= p_today + p_item.warning_days then
        status := 'EXPIRING_SOON';
      else
        status := 'VALID';
      end if;
      if m.fitness_status <> 'UNFIT' then
        next_change := app.readiness_next_date(null, m.expiry_date, p_item.warning_days, p_today);
        -- pembatasan yang berakhir atau mulai berlaku juga mengubah hasil
        select least(next_change, min(case when x.valid_from > p_today then x.valid_from
                                           when x.valid_until is not null and x.valid_until >= p_today then x.valid_until + 1 end))
          into next_change
          from medical_restriction x where x.medical_record_id = m.id and x.status = 'ACTIVE';
      end if;
    elsif exists (select 1 from medical_record mr where mr.worker_id = p_worker and mr.exam_type_id = p_item.medical_exam_type_id
                    and mr.verification_status = 'PENDING') then
      status := 'PENDING_VERIFICATION';
    elsif exists (select 1 from medical_record mr where mr.worker_id = p_worker and mr.exam_type_id = p_item.medical_exam_type_id
                    and mr.verification_status = 'REJECTED') then
      status := 'REJECTED';
    end if;
  end if;
  status := coalesce(status, 'MISSING');
  reason := coalesce(reason, status);
  if next_change is not null and next_change <= p_today then
    next_change := null;
  end if;
end $$;
revoke execute on function app.readiness_item_result(requirement_profile_item, uuid, date) from public;

-- Evaluasi satu pekerja (SRS-RE 6.1). Mengembalikan id snapshot terkini.
create function app.readiness_evaluate(p_worker uuid, p_trigger text default 'EVENT', p_by uuid default null)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c_rule constant text := 'RE-1';
  w record;
  p requirement_profile%rowtype;
  it requirement_profile_item%rowtype;
  res record;
  v_today date;
  v_tz text;
  v_status text;
  v_reason text;
  v_items jsonb := '[]'::jsonb;
  v_hash text;
  v_cur readiness_current%rowtype;
  v_snap uuid;
  v_next date;
  v_next_at timestamptz;
  v_name text;
  v_score int := 0;
  v_mand_bad boolean := false;
  v_any_warn boolean := false;
  x jsonb;
begin
  select wk.id, wk.organization_id, wk.site_id, wk.worker_status, wk.job_position_id, wk.deleted_at, s.timezone
    into w from worker wk left join site s on s.id = wk.site_id where wk.id = p_worker;
  if w.id is null then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('readiness:' || p_worker::text, 0));
  v_tz := coalesce(w.timezone, 'Asia/Jakarta');
  v_today := (now() at time zone v_tz)::date;

  if w.worker_status <> 'ACTIVE' or w.deleted_at is not null then
    v_status := 'NOT_READY'; v_reason := 'WORKER_INACTIVE';
  else
    select * into p from requirement_profile rp
     where rp.organization_id = w.organization_id and rp.job_position_id = w.job_position_id and rp.status = 'ACTIVE';
    if p.id is null then
      v_status := 'NOT_READY'; v_reason := 'PROFILE_NOT_SET';
    end if;
  end if;

  if v_reason is null then
    for it in select * from requirement_profile_item i where i.profile_id = p.id order by i.display_order, i.id loop
      res := app.readiness_item_result(it, p_worker, v_today);
      v_name := case it.item_type
        when 'COMPETENCY' then (select name from competency where id = it.competency_id)
        when 'MEDICAL' then (select name from medical_exam_type where id = it.medical_exam_type_id)
        when 'AUTHORIZATION' then (select name from authorization_type where id = it.authorization_type_id)
        else (select name from simper_type where id = it.simper_type_id)
             || coalesce(' / ' || (select name from equipment_class where id = it.equipment_class_id), '') end;
      v_items := v_items || jsonb_build_object('profile_item_id', it.id, 'item_type', it.item_type, 'item_name', v_name,
        'status', res.status, 'mandatory', it.is_mandatory, 'source_type', res.source_type, 'source_id', res.source_id,
        'expiry', res.expiry, 'reason', res.reason, 'sensitive', res.sensitive);
      if it.is_mandatory and res.status in ('EXPIRED', 'MISSING', 'PENDING_VERIFICATION', 'REJECTED', 'SUSPENDED') then
        v_mand_bad := true;
      end if;
      if res.status in ('EXPIRING_SOON', 'RESTRICTED') then
        v_any_warn := true;
      end if;
      v_next := least(v_next, res.next_change);
    end loop;
    -- SRS-RE 6.4
    v_status := case when v_mand_bad then 'NOT_READY' when v_any_warn then 'CONDITIONAL' else 'READY' end;
    -- SRS-RE 6.5: bobot komponen, rata-rata nilai item per komponen, hanya komponen yang ada
    select coalesce(round(100 * sum(cw.weight * cw.f) / nullif(sum(cw.weight), 0)), 0)::int into v_score
    from (
      select case e->>'item_type' when 'COMPETENCY' then 30 when 'MEDICAL' then 30 when 'AUTHORIZATION' then 20 else 10 end as weight,
             avg(case e->>'status' when 'VALID' then 1.0 when 'EXPIRING_SOON' then 1.0 when 'RESTRICTED' then 0.5 else 0 end) as f
      from jsonb_array_elements(v_items) e group by e->>'item_type'
    ) cw;
  end if;

  -- SRS-RE 6.6 (B-30): hash dari hasil, bukan tanggal
  v_hash := md5(concat_ws('|', c_rule, v_status, coalesce(v_reason, ''), coalesce(p.id::text, ''), coalesce(p.profile_version::text, ''),
                          w.site_id::text, v_items::text));
  -- SRS-RE 6.7: awal hari lokal Site
  v_next_at := case when v_next is not null then (v_next::timestamp at time zone v_tz) end;

  select * into v_cur from readiness_current where worker_id = p_worker for update;
  if v_cur.worker_id is not null and v_cur.input_hash = v_hash then
    update readiness_current set evaluated_at = now(), next_evaluation_at = v_next_at, version = version + 1
     where worker_id = p_worker;
    return v_cur.snapshot_id;
  end if;

  insert into readiness_snapshot (organization_id, worker_id, site_id, status, previous_status, score, reason_code, profile_id,
                                  profile_version, rule_version, input_hash, trigger_type, triggered_by)
  values (w.organization_id, p_worker, w.site_id, v_status, v_cur.status, v_score, v_reason, p.id, p.profile_version, c_rule,
          v_hash, p_trigger, p_by)
  returning id into v_snap;
  for x in select * from jsonb_array_elements(v_items) loop
    insert into readiness_snapshot_item (snapshot_id, profile_item_id, item_type, item_name, requirement_status, is_mandatory,
                                         source_record_type, source_record_id, expiry_date, reason_code, is_sensitive)
    values (v_snap, (x->>'profile_item_id')::uuid, x->>'item_type', x->>'item_name', x->>'status', (x->>'mandatory')::boolean,
            x->>'source_type', (x->>'source_id')::uuid, (x->>'expiry')::date, x->>'reason', (x->>'sensitive')::boolean);
  end loop;
  insert into readiness_current (worker_id, organization_id, site_id, snapshot_id, status, score, input_hash, evaluated_at,
                                 next_evaluation_at)
  values (p_worker, w.organization_id, w.site_id, v_snap, v_status, v_score, v_hash, now(), v_next_at)
  on conflict (worker_id) do update set site_id = excluded.site_id, snapshot_id = excluded.snapshot_id, status = excluded.status,
    score = excluded.score, input_hash = excluded.input_hash, evaluated_at = excluded.evaluated_at,
    next_evaluation_at = excluded.next_evaluation_at, version = readiness_current.version + 1;
  return v_snap;
end $$;
revoke execute on function app.readiness_evaluate(uuid, text, uuid) from public;

-- ---------------------------------------------------------------- 4. pemicu
create function app.readiness_enqueue() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record := coalesce(new, old);
  v_worker uuid;
  v_org uuid;
begin
  if tg_table_name = 'worker' then
    if tg_op = 'UPDATE' and (new.worker_status, new.job_position_id, new.site_id, new.deleted_at)
         is not distinct from (old.worker_status, old.job_position_id, old.site_id, old.deleted_at) then
      return null;
    end if;
    insert into readiness_outbox (organization_id, worker_id, event_type, payload)
    values (new.organization_id, new.id, 'WORKER_CHANGED', jsonb_build_object('op', tg_op));
    return null;
  elsif tg_table_name = 'simper_authorization' then
    select s.worker_id, s.organization_id into v_worker, v_org from simper s where s.id = r.simper_id;
  elsif tg_table_name = 'medical_restriction' then
    select m.worker_id, m.organization_id into v_worker, v_org from medical_record m where m.id = r.medical_record_id;
  else
    v_worker := (to_jsonb(r)->>'worker_id')::uuid;
    v_org := (to_jsonb(r)->>'organization_id')::uuid;
  end if;
  if v_worker is not null then
    insert into readiness_outbox (organization_id, worker_id, event_type, payload)
    values (v_org, v_worker, 'RECORD_CHANGED', jsonb_build_object('source', tg_table_name, 'op', tg_op));
  end if;
  return null;
end $$;
revoke execute on function app.readiness_enqueue() from public;
create trigger readiness_enqueue after insert or update on worker
  for each row execute function app.readiness_enqueue();
create trigger readiness_enqueue after insert or update or delete on worker_competency
  for each row execute function app.readiness_enqueue();
create trigger readiness_enqueue after insert or update or delete on worker_authorization
  for each row execute function app.readiness_enqueue();
create trigger readiness_enqueue after insert or update or delete on simper
  for each row execute function app.readiness_enqueue();
create trigger readiness_enqueue after insert or update or delete on simper_authorization
  for each row execute function app.readiness_enqueue();
create trigger readiness_enqueue after insert or update or delete on medical_record
  for each row execute function app.readiness_enqueue();
create trigger readiness_enqueue after insert or update or delete on medical_restriction
  for each row execute function app.readiness_enqueue();

create function app.readiness_profile_enqueue() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status is distinct from old.status and (new.status = 'ACTIVE' or old.status = 'ACTIVE') then
    insert into readiness_outbox (organization_id, event_type, payload)
    values (new.organization_id, 'PROFILE_ACTIVATED',
            jsonb_build_object('job_position_id', new.job_position_id, 'profile_id', new.id, 'status', new.status));
  end if;
  return null;
end $$;
revoke execute on function app.readiness_profile_enqueue() from public;
create trigger readiness_profile_enqueue after update of status on requirement_profile
  for each row execute function app.readiness_profile_enqueue();

-- Pemroses antrean (SRS-RE 7.2): peristiwa >= 5 detik digabung per pekerja; profile diperluas ke pekerja pada posisi itu.
-- Kegagalan per pekerja tidak menggagalkan yang lain; setelah 5 percobaan peristiwa FAILED (tidak dihapus, BR-RE-014).
create function app.readiness_process(p_batch int default 500) returns table (events int, workers int, failed int)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ids bigint[];
  v_events int;
  v_workers int := 0;
  v_failed int := 0;
  wk record;
begin
  select array_agg(id) into v_ids from (
    select id from readiness_outbox where status = 'PENDING' and created_at <= now() - interval '5 seconds'
    order by created_at limit greatest(p_batch, 1) for update skip locked) e;
  v_events := coalesce(cardinality(v_ids), 0);
  if v_events = 0 then
    return query select 0, 0, 0;
    return;
  end if;
  for wk in
    select x.worker_id, bool_or(x.trig = 'PROFILE_CHANGE') as by_profile, bool_or(x.trig = 'MANUAL') as manual,
           array_agg(distinct x.event_id) as event_ids
    from (
      select o.worker_id, case o.event_type when 'MANUAL_REQUEST' then 'MANUAL' else 'EVENT' end as trig, o.id as event_id
        from readiness_outbox o where o.id = any (v_ids) and o.worker_id is not null
      union all
      select w.id, 'PROFILE_CHANGE', o.id
        from readiness_outbox o join worker w on w.organization_id = o.organization_id
         and w.job_position_id = (o.payload->>'job_position_id')::uuid and w.deleted_at is null
       where o.id = any (v_ids) and o.event_type = 'PROFILE_ACTIVATED'
    ) x group by x.worker_id
  loop
    begin
      perform app.readiness_evaluate(wk.worker_id,
        case when wk.manual then 'MANUAL' when wk.by_profile then 'PROFILE_CHANGE' else 'EVENT' end, null);
      v_workers := v_workers + 1;
    exception when others then
      v_failed := v_failed + 1;
      update readiness_outbox set attempts = attempts + 1, last_error = left(sqlerrm, 500),
             status = case when attempts + 1 >= 5 then 'FAILED' else 'PENDING' end
       where id = any (wk.event_ids);
      v_ids := array(select unnest(v_ids) except select unnest(wk.event_ids));
      raise warning 'READINESS_EVALUATION_FAILED worker=% error=%', wk.worker_id, left(sqlerrm, 200);
    end;
  end loop;
  update readiness_outbox set status = 'DONE', processed_at = clock_timestamp(), attempts = attempts + 1, last_error = null
   where id = any (v_ids) and status = 'PENDING';
  return query select v_events, v_workers, v_failed;
end $$;
revoke execute on function app.readiness_process(int) from public;
grant execute on function app.readiness_process(int) to app_worker;

-- Evaluasi terjadwal (SRS-RE 7.3): hanya pekerja yang jatuh tempo, ditambah pekerja aktif yang belum pernah dievaluasi.
create function app.readiness_evaluate_due(p_limit int default 1000) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_worker uuid;
  n int := 0;
begin
  for v_worker in
    (select rc.worker_id from readiness_current rc where rc.next_evaluation_at <= now() order by rc.next_evaluation_at limit p_limit)
    union
    (select w.id from worker w where w.deleted_at is null
        and not exists (select 1 from readiness_current rc where rc.worker_id = w.id) limit p_limit)
  loop
    perform app.readiness_evaluate(v_worker, 'SCHEDULED', null);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function app.readiness_evaluate_due(int) from public;
grant execute on function app.readiness_evaluate_due(int) to app_worker;

-- Evaluasi ulang manual (FR-RE-016): readiness.evaluate pada Site pekerja (Site Admin LIMITED = Site-nya), teraudit.
create function app.readiness_evaluate_manual(p_worker uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  w record;
  v_snap uuid;
begin
  select id, organization_id, site_id into w from worker where id = p_worker and organization_id = app.current_org();
  if w.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if not exists (select 1 from app.my_permissions() mp where mp.permission_code = 'readiness.evaluate'
                   and (mp.scope_type = 'ORGANIZATION' or (mp.scope_type = 'SITE' and mp.scope_id = w.site_id))) then
    raise exception 'evaluasi ulang membutuhkan readiness.evaluate pada Site pekerja' using errcode = '42501';
  end if;
  v_snap := app.readiness_evaluate(p_worker, 'MANUAL', app.current_user_id());
  perform app.audit_enqueue(w.organization_id, 'readiness.evaluate', 'worker', p_worker, array['readiness'],
    jsonb_build_object('snapshot_id', v_snap), 'readiness.evaluate', w.site_id);
  return v_snap;
end $$;
revoke execute on function app.readiness_evaluate_manual(uuid) from public;
grant execute on function app.readiness_evaluate_manual(uuid) to app_authenticated;

-- ---------------------------------------------------------------- 5. pembacaan dengan penyamaran
-- Item snapshot. Item medis yang tidak terpenuhi disamarkan menjadi NOT_MET / MEDICAL_REQUIREMENT_NOT_MET kecuali bagi
-- pemegang medical.read_detail penuh pada Site pekerja (Dokter, Medical Officer) dan pekerja sendiri (SRS-RE 10).
-- VALID, EXPIRING_SOON, RESTRICTED tidak disamarkan: setara tingkat status medis (masa berlaku dan pembatasan operasional).
create function app.readiness_items(p_snapshot uuid)
returns table (profile_item_id uuid, item_type text, item_name text, requirement_status text, is_mandatory boolean,
               source_record_type text, source_record_id uuid, expiry_date date, reason_code text, is_sensitive boolean,
               masked boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s record;
  v_detail boolean;
begin
  select rs.id, rs.worker_id, rs.site_id into s from readiness_snapshot rs
   where rs.id = p_snapshot and rs.organization_id = app.current_org()
     and (app.has_org_wide('readiness.read') or rs.site_id = any (app.permitted_sites('readiness.read'))
          or rs.worker_id = any (app.permitted_team_workers('readiness.read'))
          or (rs.worker_id = app.my_worker_id() and app.has_self_permission('readiness.read')));
  if s.id is null then
    return;
  end if;
  v_detail := app.has_org_wide('medical.read_detail') or s.site_id = any (app.permitted_sites('medical.read_detail'))
              or (s.worker_id = app.my_worker_id() and app.has_self_permission('medical.read_detail'));
  return query
    select i.profile_item_id, i.item_type, i.item_name,
           case when i.is_sensitive and not v_detail and i.requirement_status not in ('VALID', 'EXPIRING_SOON', 'RESTRICTED')
                then 'NOT_MET' else i.requirement_status end,
           i.is_mandatory,
           case when i.is_sensitive and not v_detail then null else i.source_record_type end,
           case when i.is_sensitive and not v_detail then null else i.source_record_id end,
           case when i.is_sensitive and not v_detail and i.requirement_status not in ('VALID', 'EXPIRING_SOON', 'RESTRICTED')
                then null else i.expiry_date end,
           case when i.is_sensitive and not v_detail and i.requirement_status not in ('VALID', 'EXPIRING_SOON', 'RESTRICTED')
                then 'MEDICAL_REQUIREMENT_NOT_MET' else i.reason_code end,
           i.is_sensitive,
           (i.is_sensitive and not v_detail and i.requirement_status not in ('VALID', 'EXPIRING_SOON', 'RESTRICTED'))
      from readiness_snapshot_item i where i.snapshot_id = s.id
     order by case when i.is_mandatory then 0 else 1 end, i.item_type, i.item_name;
end $$;
revoke execute on function app.readiness_items(uuid) from public;
grant execute on function app.readiness_items(uuid) to app_authenticated;

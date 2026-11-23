-- 0008: Notifikasi in-app (M1.5)
-- Sumber: SRS-PLT02, DB-007 §4, API-015, PB-019 v2.7.
--
-- Alur (BR-PLT02-005): transaksi bisnis -> notification_event (transaksi yang sama, outbox)
--   -> app.notification_process() dijalankan app_worker -> notification (kotak masuk penerima).
-- Fase P0: hanya SYSTEM_ALERT yang aktif (PB-019). Tipe lain disemai tidak aktif sampai modulnya ada.
-- Isi notifikasi dari template dengan daftar putih variabel; tidak memuat data Sensitif (SRS-PLT02 §5).
--
-- Keputusan implementasi: tabel notification belum dipartisi. DB-007 meminta partisi bulanan, tetapi
-- PostgreSQL mewajibkan kunci partisi masuk ke setiap UNIQUE, sehingga keunikan dedup
-- (organization_id, recipient_user_id, dedup_key) tidak lagi dijamin lintas bulan. Dedup didahulukan
-- (BR-PLT02-001); partisi ditinjau ulang saat volume menuntut (M5).

-- ---------------------------------------------------------------- 1. katalog
create table notification_type (
  code                  text primary key,
  category              text not null,
  default_priority      text not null,
  can_be_disabled       boolean not null default true,
  repeat_until_resolved boolean not null default false,
  default_reminder_days integer[],
  phase                 text not null,
  is_active             boolean not null default false,
  constraint ntype_category_chk check (category in
    ('READINESS', 'EXPIRY', 'VERIFICATION', 'INSPECTION', 'OBSERVATION', 'CORRECTIVE_ACTION', 'TRAINING', 'AI', 'SYSTEM')),
  constraint ntype_priority_chk check (default_priority in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  constraint ntype_critical_chk check (default_priority <> 'CRITICAL' or not can_be_disabled),
  constraint ntype_reminder_chk check (default_reminder_days is null or cardinality(default_reminder_days) between 1 and 6)
);

insert into notification_type (code, category, default_priority, can_be_disabled, repeat_until_resolved, default_reminder_days, phase) values
  ('READINESS_NOT_READY', 'READINESS', 'HIGH', true, false, null, 'P1'),
  ('READINESS_CONDITIONAL', 'READINESS', 'MEDIUM', true, false, null, 'P1'),
  ('READINESS_READY', 'READINESS', 'LOW', true, false, null, 'P1'),
  ('COMPETENCY_EXPIRY', 'EXPIRY', 'MEDIUM', true, false, '{30,14,7}', 'P1'),
  ('MEDICAL_EXPIRY', 'EXPIRY', 'MEDIUM', true, false, '{30,14,7,1}', 'P1'),
  ('AUTHORIZATION_EXPIRY', 'EXPIRY', 'MEDIUM', true, false, '{30,14,7}', 'P1'),
  ('SIMPER_EXPIRY', 'EXPIRY', 'MEDIUM', true, false, '{30,14,7}', 'P1'),
  ('TRAINING_EXPIRY', 'EXPIRY', 'MEDIUM', true, false, '{30,14,7}', 'P3'),
  ('VERIFICATION_APPROVED', 'VERIFICATION', 'MEDIUM', true, false, null, 'P1'),
  ('VERIFICATION_REJECTED', 'VERIFICATION', 'MEDIUM', true, false, null, 'P1'),
  ('INSPECTION_ASSIGNED', 'INSPECTION', 'MEDIUM', true, false, null, 'P2'),
  ('INSPECTION_DUE', 'INSPECTION', 'MEDIUM', true, false, null, 'P2'),
  ('INSPECTION_OVERDUE', 'INSPECTION', 'HIGH', true, false, null, 'P2'),
  ('OBSERVATION_REVIEW_REQUIRED', 'OBSERVATION', 'MEDIUM', true, false, null, 'P2'),
  ('OBSERVATION_CRITICAL', 'OBSERVATION', 'CRITICAL', false, true, null, 'P2'),
  ('CORRECTIVE_ACTION_ASSIGNED', 'CORRECTIVE_ACTION', 'HIGH', true, false, null, 'P2'),
  ('CORRECTIVE_ACTION_DUE', 'CORRECTIVE_ACTION', 'HIGH', true, false, '{7,3,1}', 'P2'),
  ('CORRECTIVE_ACTION_OVERDUE', 'CORRECTIVE_ACTION', 'HIGH', true, false, null, 'P2'),
  ('CORRECTIVE_ACTION_VERIFICATION_REQUIRED', 'CORRECTIVE_ACTION', 'MEDIUM', true, false, null, 'P2'),
  ('TRAINING_ASSIGNED', 'TRAINING', 'MEDIUM', true, false, null, 'P3'),
  ('CONTRACTOR_CONTRACT_EXPIRY', 'EXPIRY', 'MEDIUM', true, false, '{30,14,7}', 'P2'),
  ('CONTRACTOR_DOCUMENT_EXPIRY', 'EXPIRY', 'MEDIUM', true, false, '{30,14,7}', 'P2'),
  ('AI_RECOMMENDATION', 'AI', 'MEDIUM', true, false, null, 'P4'),
  ('SYSTEM_ALERT', 'SYSTEM', 'LOW', true, false, null, 'P0');

-- Template: per tipe, kanal, bahasa, versi, dengan daftar putih variabel (DB-007 notification_template).
-- `variant` membedakan isi dalam satu tipe (mis. SYSTEM_ALERT untuk perubahan akses).
create table notification_template (
  id                uuid primary key default gen_random_uuid(),
  notification_type text not null references notification_type (code),
  variant           text not null default 'DEFAULT',
  channel           text not null default 'IN_APP',
  language          text not null default 'id',
  subject_template  text not null,
  body_template     text not null,
  allowed_variables text[] not null,
  version           integer not null default 1,
  constraint ntpl_channel_chk check (channel in ('IN_APP', 'PUSH', 'EMAIL')),
  constraint ntpl_language_chk check (language in ('id', 'en')),
  unique (notification_type, variant, channel, language, version)
);

-- SYSTEM_ALERT varian ACCESS_CHANGED: pemberitahuan perubahan peran akun (keputusan implementasi M1.5:
-- perubahan akses akun termasuk "peringatan sistem" PB-019; prioritas LOW = In-App saja). Tanpa nama
-- pemberi, tanpa data pribadi; hanya label peran dan jenis perubahan.
insert into notification_template (notification_type, variant, channel, language, subject_template, body_template, allowed_variables) values
  ('SYSTEM_ALERT', 'ACCESS_CHANGED', 'IN_APP', 'id',
   'Akses akun Anda berubah',
   'Peran {role_label} telah {change_label} untuk akun Anda. Buka Profil untuk melihat peran aktif Anda.',
   '{role_label,change_label,link}');

update notification_type set is_active = true where code = 'SYSTEM_ALERT';

alter table notification_type enable row level security;
alter table notification_template enable row level security;
revoke all on notification_type, notification_template from public;
grant select on notification_type, notification_template to app_authenticated, app_worker;
create policy notification_type_read on notification_type for select to app_authenticated, app_worker using (true);
create policy notification_template_read on notification_template for select to app_authenticated, app_worker using (true);

-- ---------------------------------------------------------------- 2. antrean peristiwa (outbox)
create table notification_event (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organization (id),
  notification_type text not null references notification_type (code),
  variant           text not null default 'DEFAULT',
  entity_type       text,
  entity_id         uuid,
  recipient_user_ids uuid[] not null,
  payload           jsonb not null default '{}',
  dedup_key         text not null,
  created_at        timestamptz not null default clock_timestamp(),
  processed_at      timestamptz,
  status            text not null default 'PENDING',
  attempts          integer not null default 0,
  last_error        text,
  constraint nevent_status_chk check (status in ('PENDING', 'DONE', 'FAILED'))
);
create index notification_event_pending_idx on notification_event (created_at) where status = 'PENDING';
alter table notification_event enable row level security;
alter table notification_event force row level security;
revoke all on notification_event from public;
grant select, update (processed_at, status, attempts, last_error) on notification_event to app_worker;
create policy notification_event_worker_read on notification_event for select to app_worker using (true);
create policy notification_event_worker_update on notification_event for update to app_worker using (true) with check (true);
-- Penulisan peristiwa hanya lewat fungsi SECURITY DEFINER milik pemilik migrasi (tabel memakai FORCE RLS).
create policy notification_event_definer_insert on notification_event for insert to current_user with check (true);

-- ---------------------------------------------------------------- 3. kotak masuk
create table notification (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null,
  recipient_user_id uuid not null,
  notification_type text not null references notification_type (code),
  priority          text not null,
  title             text not null,
  body              text not null,
  link              text,
  entity_type       text,
  entity_id         uuid,
  event_id          uuid references notification_event (id),
  dedup_key         text not null,
  created_at        timestamptz not null default clock_timestamp(),
  read_at           timestamptz,
  archived_at       timestamptz,
  resolved_at       timestamptz,
  last_realert_at   timestamptz,
  constraint notification_recipient_fk foreign key (recipient_user_id, organization_id)
    references user_profile (id, organization_id),
  constraint notification_priority_chk check (priority in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  constraint notification_link_chk check (link is null or link ~ '^/[a-z0-9/_-]*$'),
  unique (organization_id, recipient_user_id, dedup_key)
);
create index notification_inbox_idx on notification (recipient_user_id, created_at desc, id desc) where archived_at is null;
create index notification_unread_idx on notification (recipient_user_id) where read_at is null and archived_at is null;
create index notification_event_idx on notification (event_id);

-- Permission di scope mana pun (FULL/TEAM). Kotak masuk pribadi tidak bergantung pada scope Site.
create function app.has_any_scope(perm text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from app.my_permissions() p where p.permission_code = perm and p.constraint_level in ('FULL', 'TEAM'))
$$;
revoke execute on function app.has_any_scope(text) from public;
grant execute on function app.has_any_scope(text) to app_authenticated;

alter table notification enable row level security;
alter table notification force row level security;
revoke all on notification from public;
-- Penerima hanya membaca dan menandai miliknya sendiri (NTF-API-002); hanya read_at dan archived_at yang dapat diubah.
grant select, update (read_at, archived_at) on notification to app_authenticated;
create policy notification_own_read on notification for select to app_authenticated
  using (recipient_user_id = (select app.current_user_id()) and organization_id = (select app.current_org())
         and (select app.has_any_scope('notification.read')));
create policy notification_own_update on notification for update to app_authenticated
  using (recipient_user_id = (select app.current_user_id()) and organization_id = (select app.current_org())
         and (select app.has_any_scope('notification.read')))
  with check (recipient_user_id = (select app.current_user_id()) and organization_id = (select app.current_org()));
-- Tulis hanya pemroses peristiwa (NTF-API-001: tidak ada pembuatan dari klien)
grant insert on notification to app_worker;
create policy notification_worker_insert on notification for insert to app_worker with check (true);
-- ON CONFLICT (kunci dedup) memerlukan hak baca kolom target; hanya tiga kolom kunci, bukan isi notifikasi.
grant select (organization_id, recipient_user_id, dedup_key) on notification to app_worker;
create policy notification_worker_dedup_read on notification for select to app_worker using (true);
-- app_worker perlu membaca katalog penerima: status dan organisasi pengguna (tanpa kolom pribadi lain)
grant select (id, organization_id, status) on user_profile to app_worker;
create policy user_profile_worker_read on user_profile for select to app_worker using (true);
grant select (code, name) on role to app_worker;
create policy role_worker_read on role for select to app_worker using (true);

-- ---------------------------------------------------------------- 4. pembuatan dan pemrosesan
-- Mengisi template hanya dengan variabel yang diizinkan; placeholder lain dibiarkan kosong.
create function app.notification_render(p_template text, p_allowed text[], p_vars jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v text := p_template;
  k text;
begin
  foreach k in array p_allowed loop
    v := replace(v, '{' || k || '}', coalesce(p_vars->>k, ''));
  end loop;
  return regexp_replace(v, '\{[a-z_]+\}', '', 'g');
end $$;

-- Memproses peristiwa tertunda (idempoten: dedup per penerima). Dipanggil sebagai app_worker.
-- BR-PLT02-003: hanya penerima ACTIVE pada organisasi yang sama. Gagal 5 kali -> FAILED + peringatan.
create function app.notification_process(p_batch int default 200) returns table (processed int, created int, failed int)
language plpgsql set search_path = public, pg_temp as $$
declare
  e record;
  t record;
  tpl record;
  v_processed int := 0;
  v_created int := 0;
  v_failed int := 0;
  n int;
begin
  for e in
    select * from notification_event where status = 'PENDING' order by created_at limit greatest(p_batch, 1)
    for update skip locked
  loop
    begin
      select * into t from notification_type where code = e.notification_type;
      if not t.is_active then
        update notification_event set status = 'DONE', processed_at = clock_timestamp(), attempts = attempts + 1,
          last_error = 'TYPE_INACTIVE' where id = e.id;
        v_processed := v_processed + 1;
        continue;
      end if;
      select * into tpl from notification_template
      where notification_type = e.notification_type and variant = e.variant and channel = 'IN_APP' and language = 'id'
      order by version desc limit 1;
      if tpl.id is null then
        raise exception 'TEMPLATE_MISSING %/%', e.notification_type, e.variant;
      end if;
      insert into notification (organization_id, recipient_user_id, notification_type, priority, title, body, link,
                                entity_type, entity_id, event_id, dedup_key)
      select e.organization_id, up.id, e.notification_type, t.default_priority,
             app.notification_render(tpl.subject_template, tpl.allowed_variables, e.payload),
             app.notification_render(tpl.body_template, tpl.allowed_variables, e.payload),
             case when 'link' = any (tpl.allowed_variables) then e.payload->>'link' end,
             e.entity_type, e.entity_id, e.id, e.dedup_key
      from user_profile up
      where up.id = any (e.recipient_user_ids) and up.organization_id = e.organization_id and up.status = 'ACTIVE'
      on conflict (organization_id, recipient_user_id, dedup_key) do nothing;
      get diagnostics n = row_count;
      v_created := v_created + n;
      update notification_event set status = 'DONE', processed_at = clock_timestamp(), attempts = attempts + 1,
        last_error = null where id = e.id;
      v_processed := v_processed + 1;
    exception when others then
      update notification_event
      set attempts = attempts + 1, last_error = left(sqlerrm, 500),
          status = case when attempts + 1 >= 5 then 'FAILED' else 'PENDING' end
      where id = e.id;
      if e.attempts + 1 >= 5 then
        v_failed := v_failed + 1;
        raise warning 'NOTIFICATION_EVENT_FAILED id=% error=%', e.id, left(sqlerrm, 200);
      end if;
    end;
  end loop;
  return query select v_processed, v_created, v_failed;
end $$;

-- Peristiwa: perubahan peran akun -> SYSTEM_ALERT/ACCESS_CHANGED untuk pengguna yang bersangkutan.
create function app.notify_access_change() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_change text;
  v_role text;
begin
  if tg_op = 'INSERT' then
    v_change := 'diberikan';
  elsif old.revoked_at is null and new.revoked_at is not null then
    v_change := 'dicabut';
  else
    return null;
  end if;
  select name into v_role from role where code = new.role_code;
  insert into notification_event (organization_id, notification_type, variant, entity_type, entity_id,
                                  recipient_user_ids, payload, dedup_key)
  values (new.organization_id, 'SYSTEM_ALERT', 'ACCESS_CHANGED', 'user_role_assignment', new.id, array[new.user_id],
          jsonb_build_object('role_label', coalesce(v_role, new.role_code), 'change_label', v_change, 'link', '/profile'),
          'SYSTEM_ALERT:ACCESS_CHANGED:' || new.id || ':' || v_change);
  return null;
end $$;
create trigger notify_access_change after insert or update on user_role_assignment
  for each row execute function app.notify_access_change();

-- ---------------------------------------------------------------- 5. hak eksekusi
revoke execute on function app.notification_render(text, text[], jsonb), app.notification_process(int),
  app.notify_access_change() from public;
grant execute on function app.notification_render(text, text[], jsonb), app.notification_process(int) to app_worker;

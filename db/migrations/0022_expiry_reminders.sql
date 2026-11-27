-- 0022_expiry_reminders.sql: M3.6a notifikasi pengingat kedaluwarsa dan hasil verifikasi (PB-019 v2.7, SRS-PLT02 v1.3.6,
-- DB-007 §4.1, B-29).
-- 1. app.expiry_reminders_enqueue(): dijalankan terjadwal (tiap jam, app_worker). Untuk setiap Kompetensi, Otorisasi Kerja,
--    SIMPER dan MCU yang VERIFIED dan menjadi masa berlaku terbaru pekerja aktif, membuat notification_event pada hari
--    pengingat bawaan tipe (notification_type.default_reminder_days) dan sehari setelah berakhir ("saat kedaluwarsa").
--    Hari dihitung dengan tanggal kalender Site (BR-WF004-017). Prioritas Medium, naik High pada H-7 ke bawah dan saat
--    kedaluwarsa (PB-019). Penerima: pekerja (akun terhubung) dan petugas Site: HSE Officer; untuk MCU juga Medical Officer
--    dan Dokter (B-27). Supervisor tidak menerima (dialihkan ke READINESS_*, PB-019).
--    Idempoten: kunci dedup per item, tanggal berlaku, hari pengingat dan audiens; tidak diulang di hari yang sama
--    (BR-PLT02-004) dan berhenti begitu diperbarui (record baru VERIFIED dengan masa berlaku lebih panjang).
-- 2. Tindak lanjut Fit to Work dengan kondisi (B-27): H-7, H-1 dan hari jatuh tempo ke pekerja, Medical Officer, Dokter.
--    Tanpa catatan tindak lanjut (tingkat detail).
-- 3. VERIFICATION_APPROVED / VERIFICATION_REJECTED saat PENDING -> VERIFIED/REJECTED pada keempat modul, ke pekerja
--    pemilik data dan pengaju. Penolakan tanpa alasan dan tanpa nomor dokumen (PB-019).
-- Penimpaan jadwal per perusahaan (notification_setting, FR-PLT02-017) belum dibuat: memakai nilai bawaan.

-- ---------------------------------------------------------------- 0. prioritas per peristiwa
-- Pemroses memakai prioritas dari payload bila sah (mis. EXPIRY naik ke HIGH), selain itu prioritas bawaan tipe.
create or replace function app.notification_process(p_batch int default 200) returns table (processed int, created int, failed int)
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
      select e.organization_id, up.id, e.notification_type,
             case when e.payload->>'priority' in ('LOW', 'MEDIUM', 'HIGH') then e.payload->>'priority' else t.default_priority end,
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

create index notification_event_dedup_idx on notification_event (organization_id, dedup_key);

-- ---------------------------------------------------------------- 1. penerima petugas per Site
-- Pengguna aktif yang memegang salah satu peran pada scope perusahaan atau Site itu.
create function app.notification_staff(p_org uuid, p_site uuid, p_roles text[]) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct ura.user_id), '{}'::uuid[])
  from user_role_assignment ura
  join user_profile up on up.id = ura.user_id and up.status = 'ACTIVE' and up.organization_id = p_org
  where ura.organization_id = p_org and ura.revoked_at is null and ura.role_code = any (p_roles)
    and (ura.scope_type = 'ORGANIZATION' or (ura.scope_type = 'SITE' and ura.scope_id = p_site))
$$;
revoke execute on function app.notification_staff(uuid, uuid, text[]) from public;

-- ---------------------------------------------------------------- 2. template
insert into notification_template (notification_type, variant, channel, language, subject_template, body_template, allowed_variables)
select t.code, v.variant, 'IN_APP', 'id', v.subject, v.body, v.vars
from (values ('COMPETENCY_EXPIRY'), ('AUTHORIZATION_EXPIRY'), ('SIMPER_EXPIRY'), ('MEDICAL_EXPIRY')) as t(code)
cross join (values
  ('SELF', '{item_kind} Anda {when_short}',
   '{item_kind} {item_name} Anda {when_label}. Perbarui dan ajukan verifikasi agar tetap memenuhi syarat.',
   '{item_kind,item_name,when_short,when_label,link}'::text[]),
  ('STAFF', '{item_kind} pekerja {when_short}',
   '{item_kind} {item_name} milik {worker_name} {when_label}.',
   '{item_kind,item_name,worker_name,when_short,when_label,link}'::text[])
) as v(variant, subject, body, vars);

insert into notification_template (notification_type, variant, channel, language, subject_template, body_template, allowed_variables) values
  ('MEDICAL_EXPIRY', 'FOLLOW_UP_SELF', 'IN_APP', 'id', 'Tindak lanjut medis {when_short}',
   'Tindak lanjut medis Anda {when_label}. Hubungi klinik site.', '{when_short,when_label,link}'),
  ('MEDICAL_EXPIRY', 'FOLLOW_UP_STAFF', 'IN_APP', 'id', 'Tindak lanjut medis pekerja {when_short}',
   'Tindak lanjut medis {worker_name} {when_label}.', '{worker_name,when_short,when_label,link}');

insert into notification_template (notification_type, variant, channel, language, subject_template, body_template, allowed_variables) values
  ('VERIFICATION_APPROVED', 'SELF', 'IN_APP', 'id', '{item_kind} Anda sudah diverifikasi',
   'Pengajuan {item_kind} {item_name} Anda sudah diverifikasi.', '{item_kind,item_name,link}'),
  ('VERIFICATION_APPROVED', 'STAFF', 'IN_APP', 'id', 'Pengajuan {item_kind} sudah diverifikasi',
   'Pengajuan {item_kind} {item_name} untuk {worker_name} sudah diverifikasi.', '{item_kind,item_name,worker_name,link}'),
  ('VERIFICATION_REJECTED', 'SELF', 'IN_APP', 'id', 'Pengajuan {item_kind} perlu diperbaiki',
   'Pengajuan perlu diperbaiki. Buka aplikasi untuk melihat alasan.', '{item_kind,link}'),
  ('VERIFICATION_REJECTED', 'STAFF', 'IN_APP', 'id', 'Pengajuan {item_kind} perlu diperbaiki',
   'Pengajuan perlu diperbaiki. Buka aplikasi untuk melihat alasan.', '{item_kind,link}');

update notification_type set is_active = true
 where code in ('COMPETENCY_EXPIRY', 'AUTHORIZATION_EXPIRY', 'SIMPER_EXPIRY', 'MEDICAL_EXPIRY',
                'VERIFICATION_APPROVED', 'VERIFICATION_REJECTED');

-- ---------------------------------------------------------------- 3. pengingat kedaluwarsa terjadwal
create function app.expiry_reminders_enqueue() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
  v_marker int;
  v_when_short text;
  v_when_label text;
  v_priority text;
  v_staff uuid[];
  v_payload jsonb;
  v_key text;
  v_count int := 0;
  aud text;
  v_recipients uuid[];
begin
  for r in
    with items as (
      -- Kompetensi: masa berlaku terbaru per pekerja dan kompetensi
      select wc.organization_id, wc.site_id, wc.worker_id, 'worker_competency'::text as entity_type, wc.id as entity_id,
             'COMPETENCY_EXPIRY'::text as ntype, 'Kompetensi'::text as item_kind, c.name as item_name, wc.valid_until
      from worker_competency wc join competency c on c.id = wc.competency_id
      where wc.verification_status = 'VERIFIED' and wc.valid_until is not null
        and not exists (select 1 from worker_competency o where o.worker_id = wc.worker_id and o.competency_id = wc.competency_id
                          and o.verification_status = 'VERIFIED' and o.id <> wc.id
                          and (o.valid_until is null or o.valid_until > wc.valid_until))
      union all
      select wa.organization_id, wa.site_id, wa.worker_id, 'worker_authorization', wa.id,
             'AUTHORIZATION_EXPIRY', 'Otorisasi Kerja', t.name, wa.valid_until
      from worker_authorization wa join authorization_type t on t.id = wa.authorization_type_id
      where wa.verification_status = 'VERIFIED' and wa.suspension_status = 'NONE' and wa.valid_until is not null
        and not exists (select 1 from worker_authorization o where o.worker_id = wa.worker_id
                          and o.authorization_type_id = wa.authorization_type_id and o.verification_status = 'VERIFIED'
                          and o.suspension_status = 'NONE' and o.id <> wa.id
                          and (o.valid_until is null or o.valid_until > wa.valid_until))
      union all
      select s.organization_id, s.site_id, s.worker_id, 'simper', s.id, 'SIMPER_EXPIRY', 'SIMPER', t.name, s.valid_until
      from simper s join simper_type t on t.id = s.simper_type_id
      where s.verification_status = 'VERIFIED' and s.suspension_status = 'NONE' and s.valid_until is not null
        and not exists (select 1 from simper o where o.worker_id = s.worker_id and o.simper_type_id = s.simper_type_id
                          and o.verification_status = 'VERIFIED' and o.suspension_status = 'NONE' and o.id <> s.id
                          and (o.valid_until is null or o.valid_until > s.valid_until))
      union all
      -- MCU: record terverifikasi terbaru pekerja (sama dengan app.medical_status), bukan UNFIT
      select m.organization_id, m.site_id, m.worker_id, 'medical_record', m.id, 'MEDICAL_EXPIRY', 'MCU', t.name, m.expiry_date
      from medical_record m join medical_exam_type t on t.id = m.exam_type_id
      where m.verification_status = 'VERIFIED' and m.fitness_status <> 'UNFIT'
        and not exists (select 1 from medical_record o where o.worker_id = m.worker_id and o.verification_status = 'VERIFIED'
                          and o.id <> m.id
                          and (o.examination_date, o.verified_at) > (m.examination_date, m.verified_at))
    )
    select i.*, w.full_name, w.user_id, (i.valid_until - app.site_today(i.site_id)) as days_left, nt.default_reminder_days
    from items i
    join worker w on w.id = i.worker_id and w.worker_status = 'ACTIVE' and w.deleted_at is null
    join notification_type nt on nt.code = i.ntype and nt.is_active
    where (i.valid_until - app.site_today(i.site_id)) = any (nt.default_reminder_days)
       or (i.valid_until - app.site_today(i.site_id)) = -1
  loop
    v_marker := r.days_left;
    if v_marker < 0 then
      v_when_short := 'telah berakhir';
      v_when_label := 'telah berakhir pada ' || to_char(r.valid_until, 'DD-MM-YYYY');
    else
      v_when_short := 'segera berakhir';
      v_when_label := case when v_marker = 1 then 'berakhir besok' else 'berakhir dalam ' || v_marker || ' hari' end
                      || ' (' || to_char(r.valid_until, 'DD-MM-YYYY') || ')';
    end if;
    v_priority := case when v_marker <= 7 then 'HIGH' else 'MEDIUM' end;
    v_staff := app.notification_staff(r.organization_id, r.site_id,
                 case when r.ntype = 'MEDICAL_EXPIRY' then array['HSE_OFFICER', 'MEDICAL_OFFICER', 'DOCTOR']
                      else array['HSE_OFFICER'] end);
    foreach aud in array array['SELF', 'STAFF'] loop
      v_recipients := case when aud = 'SELF' then
                        case when r.user_id is not null then array[r.user_id] else '{}'::uuid[] end
                      else array(select x from unnest(v_staff) x where x is distinct from r.user_id) end;
      continue when cardinality(v_recipients) = 0;
      v_key := format('%s:%s:%s:%s:%s', r.ntype, r.entity_id, r.valid_until, v_marker, aud);
      continue when exists (select 1 from notification_event e where e.organization_id = r.organization_id and e.dedup_key = v_key);
      v_payload := jsonb_build_object('item_kind', r.item_kind, 'item_name', r.item_name, 'worker_name', r.full_name,
                     'when_short', v_when_short, 'when_label', v_when_label, 'priority', v_priority,
                     'link', case when aud = 'SELF' then '/profile' else '/workers/' || r.worker_id end);
      insert into notification_event (organization_id, notification_type, variant, entity_type, entity_id, recipient_user_ids,
                                      payload, dedup_key)
      values (r.organization_id, r.ntype, aud, r.entity_type, r.entity_id, v_recipients, v_payload, v_key);
      v_count := v_count + 1;
    end loop;
  end loop;

  -- tindak lanjut Fit to Work dengan kondisi: H-7, H-1, hari jatuh tempo; hanya record MCU terbaru
  for r in
    select m.organization_id, m.site_id, m.worker_id, m.id as entity_id, m.follow_up_due, w.full_name, w.user_id,
           (m.follow_up_due - app.site_today(m.site_id)) as days_left
    from medical_record m
    join worker w on w.id = m.worker_id and w.worker_status = 'ACTIVE' and w.deleted_at is null
    where m.verification_status = 'VERIFIED' and m.fitness_status = 'FIT_WITH_CONDITION' and m.follow_up_due is not null
      and (m.follow_up_due - app.site_today(m.site_id)) in (7, 1, 0)
      and not exists (select 1 from medical_record o where o.worker_id = m.worker_id and o.verification_status = 'VERIFIED'
                        and o.id <> m.id and (o.examination_date, o.verified_at) > (m.examination_date, m.verified_at))
      and exists (select 1 from notification_type nt where nt.code = 'MEDICAL_EXPIRY' and nt.is_active)
  loop
    v_when_short := case when r.days_left = 0 then 'jatuh tempo hari ini' else 'segera jatuh tempo' end;
    v_when_label := case when r.days_left = 0 then 'jatuh tempo hari ini'
                         when r.days_left = 1 then 'jatuh tempo besok'
                         else 'jatuh tempo dalam ' || r.days_left || ' hari' end
                    || ' (' || to_char(r.follow_up_due, 'DD-MM-YYYY') || ')';
    v_staff := app.notification_staff(r.organization_id, r.site_id, array['MEDICAL_OFFICER', 'DOCTOR']);
    foreach aud in array array['SELF', 'STAFF'] loop
      v_recipients := case when aud = 'SELF' then
                        case when r.user_id is not null then array[r.user_id] else '{}'::uuid[] end
                      else array(select x from unnest(v_staff) x where x is distinct from r.user_id) end;
      continue when cardinality(v_recipients) = 0;
      v_key := format('MEDICAL_FOLLOW_UP:%s:%s:%s:%s', r.entity_id, r.follow_up_due, r.days_left, aud);
      continue when exists (select 1 from notification_event e where e.organization_id = r.organization_id and e.dedup_key = v_key);
      insert into notification_event (organization_id, notification_type, variant, entity_type, entity_id, recipient_user_ids,
                                      payload, dedup_key)
      values (r.organization_id, 'MEDICAL_EXPIRY', 'FOLLOW_UP_' || aud, 'medical_record', r.entity_id, v_recipients,
              jsonb_build_object('worker_name', r.full_name, 'when_short', v_when_short, 'when_label', v_when_label,
                                 'priority', case when r.days_left <= 1 then 'HIGH' else 'MEDIUM' end,
                                 'link', case when aud = 'SELF' then '/profile' else '/workers/' || r.worker_id end),
              v_key);
      v_count := v_count + 1;
    end loop;
  end loop;
  return v_count;
end $$;
revoke execute on function app.expiry_reminders_enqueue() from public;
grant execute on function app.expiry_reminders_enqueue() to app_worker;

-- ---------------------------------------------------------------- 4. hasil verifikasi
create function app.notify_verification() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_kind text;
  v_name text;
  v_worker record;
  v_type text := case when new.verification_status = 'VERIFIED' then 'VERIFICATION_APPROVED' else 'VERIFICATION_REJECTED' end;
  v_stamp text := to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS');
  aud text;
  v_recipients uuid[];
begin
  if not (old.verification_status = 'PENDING' and new.verification_status in ('VERIFIED', 'REJECTED')) then
    return null;
  end if;
  if tg_table_name = 'worker_competency' then
    v_kind := 'Kompetensi';
    select name into v_name from competency where id = new.competency_id;
  elsif tg_table_name = 'worker_authorization' then
    v_kind := 'Otorisasi Kerja';
    select name into v_name from authorization_type where id = new.authorization_type_id;
  elsif tg_table_name = 'simper' then
    v_kind := 'SIMPER';
    select name into v_name from simper_type where id = new.simper_type_id;
  else
    v_kind := 'MCU';
    select name into v_name from medical_exam_type where id = new.exam_type_id;
  end if;
  select id, full_name, user_id into v_worker from worker where id = new.worker_id;
  foreach aud in array array['SELF', 'STAFF'] loop
    v_recipients := case when aud = 'SELF' then
                      case when v_worker.user_id is not null then array[v_worker.user_id] else '{}'::uuid[] end
                    when new.created_by is distinct from v_worker.user_id then array[new.created_by]
                    else '{}'::uuid[] end;
    continue when cardinality(v_recipients) = 0;
    insert into notification_event (organization_id, notification_type, variant, entity_type, entity_id, recipient_user_ids,
                                    payload, dedup_key)
    values (new.organization_id, v_type, aud, tg_table_name, new.id, v_recipients,
            jsonb_build_object('item_kind', v_kind, 'item_name', v_name, 'worker_name', v_worker.full_name,
                               'link', case when aud = 'SELF' then '/profile' else '/workers/' || new.worker_id end),
            format('VERIF:%s:%s:%s:%s', tg_table_name, new.id, v_stamp, aud));
  end loop;
  return null;
end $$;
revoke execute on function app.notify_verification() from public;

create trigger notify_verification after update of verification_status on worker_competency
  for each row execute function app.notify_verification();
create trigger notify_verification after update of verification_status on worker_authorization
  for each row execute function app.notify_verification();
create trigger notify_verification after update of verification_status on simper
  for each row execute function app.notify_verification();
create trigger notify_verification after update of verification_status on medical_record
  for each row execute function app.notify_verification();

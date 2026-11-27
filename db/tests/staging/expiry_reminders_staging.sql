-- expiry_reminders_staging.sql: uji migrasi 0022 (M3.6a, B-29) untuk Supabase SQL Editor. Data sintetis.
-- Diakhiri exception: semua perubahan dibatalkan (termasuk notifikasi yang dibuat selama uji).

do $test$
declare
  org_a uuid; site_a uuid; site_self uuid; u_hseo uuid; u_mgr uuid; u_mo uuid; u_doc uuid; u_spv uuid; u_wrk uuid;
  w_self uuid; w_other uuid; today date; cmp uuid; atype uuid; t_mcu uuid;
  wc30 uuid; wc7 uuid; wcx uuid; wc_renew uuid; wa uuid; mcu uuid; v_pending uuid;
  n bigint; r record; checks int := 0;
begin
  select id into org_a from organization order by name limit 1;
  select id into u_hseo from user_profile where organization_id = org_a and email like 'hseo1@%';
  select id into u_mgr from user_profile where organization_id = org_a and email like 'hsemgr@%';
  select id into u_mo from user_profile where organization_id = org_a and email like 'medis@%';
  select id into u_doc from user_profile where organization_id = org_a and email like 'dokter@%';
  select id into u_spv from user_profile where organization_id = org_a and email like 'spv1@%';
  select id into u_wrk from user_profile where organization_id = org_a and email like 'pekerja1@%';
  select scope_id into site_a from user_role_assignment where user_id = u_hseo and scope_type = 'SITE' and revoked_at is null limit 1;
  select id, site_id into w_self, site_self from worker where user_id = u_wrk;
  select id into w_other from worker where site_id = site_a and user_id is null and worker_status = 'ACTIVE' order by id limit 1;
  today := app.site_today(site_a);
  insert into competency (organization_id, name, code) values (org_a, 'Uji Kerja Panas', 'UJI-PANAS') returning id into cmp;
  insert into authorization_type (organization_id, name, code) values (org_a, 'Uji Otorisasi', 'UJI-OTO') returning id into atype;
  select id into t_mcu from medical_exam_type where organization_id = org_a and code = 'MCU-PERIODIC';

  -- kosongkan antrean awal agar hitungan jelas
  set local role app_worker;
  perform app.notification_process(100000);
  reset role;

  -- data: kompetensi H-30 (pekerja dengan akun), H-7, kedaluwarsa kemarin; satu yang sudah diperbarui; otorisasi H-14
  insert into worker_competency (organization_id, site_id, worker_id, competency_id, valid_from, valid_until, created_by,
                                 verification_status, verified_by, verified_at)
  values (org_a, site_self, w_self, cmp, today - 300, today + 30, u_hseo, 'VERIFIED', u_mgr, now()) returning id into wc30;
  insert into worker_competency (organization_id, site_id, worker_id, competency_id, valid_from, valid_until, created_by,
                                 verification_status, verified_by, verified_at)
  values (org_a, site_a, w_other, cmp, today - 300, today + 7, u_hseo, 'VERIFIED', u_mgr, now()) returning id into wc7;
  insert into worker_competency (organization_id, site_id, worker_id, competency_id, valid_from, valid_until, created_by,
                                 verification_status, verified_by, verified_at)
  select org_a, site_a, w.id, cmp, today - 300, today - 1, u_hseo, 'VERIFIED', u_mgr, now()
    from worker w where w.site_id = site_a and w.user_id is null and w.worker_status = 'ACTIVE' and w.id <> w_other
   order by w.id limit 1 returning id into wcx;
  -- diperbarui: record lama H-14 dan record baru berlaku setahun -> tidak ada pengingat untuk record lama
  insert into worker_competency (organization_id, site_id, worker_id, competency_id, valid_from, valid_until, created_by,
                                 verification_status, verified_by, verified_at)
  select org_a, site_a, w.id, cmp, today - 300, today + 14, u_hseo, 'VERIFIED', u_mgr, now()
    from worker w where w.site_id = site_a and w.user_id is null and w.worker_status = 'ACTIVE'
     and w.id not in (w_other, (select worker_id from worker_competency where id = wcx))
   order by w.id limit 1 returning id into wc_renew;
  insert into worker_competency (organization_id, site_id, worker_id, competency_id, valid_from, valid_until, created_by,
                                 verification_status, verified_by, verified_at)
  select organization_id, site_id, worker_id, competency_id, today, today + 365, u_hseo, 'VERIFIED', u_mgr, now()
    from worker_competency where id = wc_renew;
  insert into worker_authorization (organization_id, site_id, worker_id, authorization_type_id, valid_from, valid_until,
                                    created_by, verification_status, verified_by, verified_at)
  values (org_a, site_self, w_self, atype, today - 100, today + 14, u_hseo, 'VERIFIED', u_mgr, now()) returning id into wa;
  -- MCU terbaru pekerja sendiri berakhir besok (H-1 khusus Medical)
  insert into medical_record (organization_id, site_id, worker_id, exam_type_id, examination_date, expiry_date, created_by,
                              verification_status, fitness_status, verified_by, verified_at)
  values (org_a, site_self, w_self, t_mcu, today, today + 1, u_hseo, 'VERIFIED', 'FIT', u_doc, now()) returning id into mcu;

  -- E1 menjalankan pengingat (app_worker): peristiwa sesuai hari pengingat
  set local role app_worker;
  n := app.expiry_reminders_enqueue();
  reset role;
  if not exists (select 1 from notification_event where entity_id = wc30 and variant = 'SELF' and recipient_user_ids = array[u_wrk]
                   and payload->>'priority' = 'MEDIUM') then raise exception 'E1 GAGAL: H-30 kompetensi ke pekerja'; end if;
  if exists (select 1 from notification_event where entity_id = wc30 and variant = 'STAFF' and u_wrk = any (recipient_user_ids)) then
    raise exception 'E1 GAGAL: pekerja menerima notifikasi petugas';
  end if;
  if not exists (select 1 from notification_event where entity_id = wc7 and variant = 'STAFF' and payload->>'priority' = 'HIGH'
                   and u_hseo = any (recipient_user_ids) and not (u_spv = any (recipient_user_ids))
                   and not (u_mgr = any (recipient_user_ids))) then
    raise exception 'E1 GAGAL: H-7 naik High ke HSE Officer Site (tanpa Supervisor dan HSE Manager)';
  end if;
  if exists (select 1 from notification_event where entity_id = wc7 and variant = 'SELF') then
    raise exception 'E1 GAGAL: pekerja tanpa akun diberi notifikasi pribadi';
  end if;
  if not exists (select 1 from notification_event where entity_id = wcx and payload->>'when_short' = 'telah berakhir'
                   and payload->>'priority' = 'HIGH') then raise exception 'E1 GAGAL: pemberitahuan saat kedaluwarsa'; end if;
  if exists (select 1 from notification_event where entity_id = wc_renew) then
    raise exception 'E1 GAGAL: pengingat untuk record yang sudah diperbarui';
  end if;
  if not exists (select 1 from notification_event where entity_id = wa and notification_type = 'AUTHORIZATION_EXPIRY') then
    raise exception 'E1 GAGAL: otorisasi H-14';
  end if;
  select * into r from notification_event where entity_id = mcu and variant = 'STAFF';
  if r.id is null or not (u_mo = any (r.recipient_user_ids)) or not (u_doc = any (r.recipient_user_ids))
     or r.payload->>'when_label' not like 'berakhir besok%' then
    raise exception 'E1 GAGAL: MCU H-1 ke Medical Officer dan Dokter (%)', r;
  end if;
  if exists (select 1 from notification_event where entity_id = mcu and variant = 'STAFF' and u_hseo = any (recipient_user_ids))
     and site_self <> site_a then
    raise exception 'E1 GAGAL: HSE Officer Site lain menerima pengingat';
  end if;
  checks := checks + 8;

  -- E2 idempoten: dijalankan ulang (jam berikutnya) tidak menambah peristiwa
  select count(*) into n from notification_event;
  set local role app_worker;
  perform app.expiry_reminders_enqueue();
  reset role;
  if (select count(*) from notification_event) <> n then raise exception 'E2 GAGAL: pengingat ganda di hari yang sama'; end if;
  checks := checks + 1;

  -- E3 pemrosesan: notifikasi masuk kotak masuk dengan prioritas peristiwa, tanpa placeholder, tautan aman
  set local role app_worker;
  perform app.notification_process(100000);
  reset role;
  select * into r from notification where entity_id = wc30 and recipient_user_id = u_wrk;
  if r.id is null or r.title <> 'Kompetensi Anda segera berakhir' or r.body not like '%Uji Kerja Panas Anda berakhir dalam 30 hari%'
     or r.link <> '/profile' or r.priority <> 'MEDIUM' then
    raise exception 'E3 GAGAL: isi notifikasi pekerja (%)', r;
  end if;
  if (select priority from notification where entity_id = wc7 and recipient_user_id = u_hseo) <> 'HIGH' then
    raise exception 'E3 GAGAL: prioritas High tidak diterapkan';
  end if;
  if exists (select 1 from notification where (title ~ '\{' or body ~ '\{') and entity_id in (wc30, wc7, wcx, wa, mcu)) then
    raise exception 'E3 GAGAL: placeholder tersisa';
  end if;
  if (select link from notification where entity_id = wc7 and recipient_user_id = u_hseo) <> '/workers/' || w_other then
    raise exception 'E3 GAGAL: tautan petugas';
  end if;
  checks := checks + 4;

  -- E4 tindak lanjut Fit to Work dengan kondisi: hari jatuh tempo ke pekerja, Medical Officer, Dokter (bukan HSE Officer)
  update medical_record set verification_status = 'PENDING', fitness_status = null, verified_by = null, verified_at = null where id = mcu;
  update medical_record set verification_status = 'VERIFIED', fitness_status = 'FIT_WITH_CONDITION', verified_by = u_doc,
         verified_at = now(), follow_up_note = 'Kontrol ulang sintetis', follow_up_due = today, expiry_date = today + 300
   where id = mcu;
  set local role app_worker;
  perform app.expiry_reminders_enqueue();
  reset role;
  select * into r from notification_event where entity_id = mcu and variant = 'FOLLOW_UP_STAFF';
  if r.id is null or exists (select 1 from user_role_assignment x where x.user_id = any (r.recipient_user_ids)
                               and x.role_code = 'HSE_OFFICER' and x.revoked_at is null
                               and not exists (select 1 from user_role_assignment y where y.user_id = x.user_id
                                                 and y.role_code in ('MEDICAL_OFFICER', 'DOCTOR') and y.revoked_at is null))
     or not (u_doc = any (r.recipient_user_ids))
     or r.payload::text like '%Kontrol ulang%' or r.payload->>'priority' <> 'HIGH' then
    raise exception 'E4 GAGAL: tindak lanjut (%)', r;
  end if;
  checks := checks + 1;

  -- E5 hasil verifikasi: pengajuan pekerja diverifikasi/ditolak -> pekerja dan pengaju; penolakan tanpa alasan
  insert into worker_competency (organization_id, site_id, worker_id, competency_id, valid_from, valid_until, created_by)
  values (org_a, site_self, w_self, cmp, today, today + 365, u_hseo) returning id into v_pending;
  update worker_competency set verification_status = 'REJECTED', verified_by = u_mgr, verified_at = now(),
         rejection_reason = 'Sertifikat buram rahasia' where id = v_pending;
  select * into r from notification_event where entity_id = v_pending and notification_type = 'VERIFICATION_REJECTED' and variant = 'SELF';
  if r.id is null or r.recipient_user_ids <> array[u_wrk] then raise exception 'E5 GAGAL: penolakan ke pekerja'; end if;
  if not exists (select 1 from notification_event where entity_id = v_pending and notification_type = 'VERIFICATION_REJECTED'
                   and variant = 'STAFF' and recipient_user_ids = array[u_hseo]) then
    raise exception 'E5 GAGAL: penolakan ke pengaju';
  end if;
  set local role app_worker;
  perform app.notification_process(100000);
  reset role;
  if exists (select 1 from notification where entity_id = v_pending and (body like '%buram%' or title like '%buram%')) then
    raise exception 'E5 GAGAL: alasan penolakan bocor ke notifikasi';
  end if;
  if (select body from notification where entity_id = v_pending and recipient_user_id = u_wrk)
     <> 'Pengajuan perlu diperbaiki. Buka aplikasi untuk melihat alasan.' then
    raise exception 'E5 GAGAL: isi penolakan';
  end if;
  checks := checks + 4;

  raise exception 'HASIL_UJI LULUS: % pemeriksaan pengingat dan notifikasi verifikasi (perubahan uji dibatalkan)', checks;
end
$test$;

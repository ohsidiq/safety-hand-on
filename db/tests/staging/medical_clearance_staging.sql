-- medical_clearance_staging.sql: uji migrasi 0020 (B-27) untuk Supabase SQL Editor. Menyiapkan data uji sendiri (jenis kerja
-- khusus, MCU FIT/pembatasan/UNFIT) di dalam blok. Data sintetis. Diakhiri exception: semua perubahan dibatalkan.

do $test$
declare
  org_a uuid; u_hseo uuid; u_mo uuid; u_doc uuid; u_spv uuid; u_wrk uuid; u_b uuid;
  site_a1 uuid; w_fit uuid; w_restr uuid; w_unfit uuid; w_self uuid; t_mcu uuid; t_height uuid; t_confined uuid;
  rec uuid; c uuid; r record; n bigint; ws uuid[]; checks int := 0;
begin
  select id into org_a from organization order by name limit 1;
  select id into u_hseo from user_profile where organization_id = org_a and email like 'hseo1@%';
  select id into u_mo from user_profile where organization_id = org_a and email like 'medis@%';
  select id into u_doc from user_profile where organization_id = org_a and email like 'dokter@%';
  select id into u_spv from user_profile where organization_id = org_a and email like 'spv1@%';
  select id into u_wrk from user_profile where organization_id = org_a and email like 'pekerja1@%';
  select id into u_b from user_profile where organization_id = (select id from organization order by name offset 1 limit 1)
    and email like 'admin@%';
  select scope_id into site_a1 from user_role_assignment where user_id = u_hseo and scope_type = 'SITE' and revoked_at is null limit 1;
  select id into w_self from worker where user_id = u_wrk;
  -- data uji sendiri (dibatalkan bersama blok)
  insert into medical_exam_type (organization_id, name, code, default_validity_months)
  select org_a, 'Uji MCU Sintetis', 'MCU-PERIODIC', 12
   where not exists (select 1 from medical_exam_type where organization_id = org_a and code = 'MCU-PERIODIC' and status = 'ACTIVE');
  select id into t_mcu from medical_exam_type where organization_id = org_a and code = 'MCU-PERIODIC' and status = 'ACTIVE';
  insert into medical_clearance_type (organization_id, name, code, validity_hours, blocking_restriction_codes)
  values (org_a, 'Uji Kerja di Ketinggian', 'UJI-HEIGHT', 12, array['NO_WORK_AT_HEIGHT']) returning id into t_height;
  insert into medical_clearance_type (organization_id, name, code, validity_hours)
  values (org_a, 'Uji Ruang Terbatas', 'UJI-CONFINED', 12) returning id into t_confined;
  select array_agg(id order by id) into ws from (
    select w.id from worker w where w.site_id = site_a1 and w.worker_status = 'ACTIVE'
       and w.id is distinct from w_self
     order by w.id limit 3) x;
  if coalesce(array_length(ws, 1), 0) < 3 then raise exception 'SETUP GAGAL: kurang dari 3 pekerja aktif di Site uji'; end if;
  w_fit := ws[1]; w_restr := ws[2]; w_unfit := ws[3];
  insert into medical_record (organization_id, site_id, worker_id, exam_type_id, examination_date, expiry_date, created_by,
                              verification_status, fitness_status, verified_by, verified_at, unfit_until)
  values (org_a, site_a1, w_fit, t_mcu, current_date - 1, current_date + 364, u_hseo, 'VERIFIED', 'FIT', u_doc, now(), null),
         (org_a, site_a1, w_restr, t_mcu, current_date - 1, current_date + 364, u_hseo, 'VERIFIED', 'FIT_WITH_RESTRICTION', u_doc, now(), null),
         (org_a, site_a1, w_unfit, t_mcu, current_date - 1, current_date + 364, u_hseo, 'VERIFIED', 'UNFIT', u_doc, now(), current_date + 30);
  insert into medical_restriction (organization_id, medical_record_id, restriction_code, operational_description, valid_from, valid_until, created_by)
  select org_a, m.id, 'NO_WORK_AT_HEIGHT', 'Tidak bekerja di ketinggian di atas 2 meter', current_date - 10, current_date + 180, u_doc
    from medical_record m where m.worker_id = w_restr and m.examination_date = current_date - 1 and m.created_by = u_hseo;
  if u_doc is null or t_height is null or w_fit is null or w_restr is null or w_unfit is null then
    raise exception 'SETUP GAGAL: % % % % %', u_doc, t_height, w_fit, w_restr, w_unfit;
  end if;

  -- D1 matriks peran: Dokter memegang medical.verify + medical.clearance; Medical Officer tidak lagi medical.verify
  if not exists (select 1 from role_permission where role_code = 'DOCTOR' and permission_code = 'medical.clearance' and constraint_level = 'FULL')
     or not exists (select 1 from role_permission where role_code = 'DOCTOR' and permission_code = 'medical.verify')
     or exists (select 1 from role_permission where role_code = 'MEDICAL_OFFICER' and permission_code in ('medical.verify', 'medical.clearance')) then
    raise exception 'D1 GAGAL: grant peran Dokter/Medical Officer salah';
  end if;
  if exists (select 1 from medical_record where fitness_status = 'TEMPORARILY_UNFIT') then
    raise exception 'D1 GAGAL: TEMPORARILY_UNFIT tersisa';
  end if;
  checks := checks + 2;

  -- D2 Dokter menetapkan FIT_WITH_CONDITION dengan tindak lanjut; status menampilkan tanggal, bukan catatan
  set local role app_authenticated;
  perform set_config('app.user_id', u_mo::text, true);
  insert into medical_record (organization_id, site_id, worker_id, exam_type_id, examination_date, expiry_date, provider, created_by)
  values (org_a, site_a1, w_fit, t_mcu, current_date, current_date + 365, 'Klinik Sintetis', u_mo) returning id into rec;
  perform set_config('app.user_id', u_doc::text, true);
  begin
    update medical_record set verification_status = 'VERIFIED', fitness_status = 'FIT_WITH_CONDITION', verified_by = u_doc,
           verified_at = now() where id = rec;
    raise exception 'D2 GAGAL: FIT_WITH_CONDITION tanpa tindak lanjut diterima';
  exception when check_violation then null;
  end;
  update medical_record set verification_status = 'VERIFIED', fitness_status = 'FIT_WITH_CONDITION', verified_by = u_doc,
         verified_at = now(), follow_up_note = 'Kontrol tensi ulang di klinik site', follow_up_due = current_date + 14
   where id = rec;
  perform set_config('app.user_id', u_spv::text, true);
  select * into r from app.medical_status(w_fit);
  if r.fitness_status <> 'FIT_WITH_CONDITION' or r.validity_status <> 'VALID' or r.follow_up_due <> current_date + 14 then
    raise exception 'D2 GAGAL: status tingkat Supervisor salah (%)', r;
  end if;
  if exists (select 1 from medical_record where id = rec) then raise exception 'D2 GAGAL: Supervisor membaca catatan tindak lanjut'; end if;
  checks := checks + 3;

  -- D3 pemeriksaan kesiapan: hanya Dokter; SIAP butuh checklist lengkap dan masa berlaku <= 24 jam
  perform set_config('app.user_id', u_mo::text, true);
  begin
    insert into medical_clearance (organization_id, site_id, worker_id, clearance_type_id, result, history_reviewed,
                                   blood_pressure_checked, vital_signs_checked, vitals_within_limits, examined_by, valid_until)
    values (org_a, site_a1, w_fit, t_height, 'CLEARED', true, true, true, true, u_mo, now() + interval '12 hours');
    raise exception 'D3 GAGAL: Medical Officer menerbitkan kesiapan';
  exception when insufficient_privilege then null;
  end;
  perform set_config('app.user_id', u_hseo::text, true);
  begin
    insert into medical_clearance (organization_id, site_id, worker_id, clearance_type_id, result, history_reviewed,
                                   blood_pressure_checked, vital_signs_checked, vitals_within_limits, examined_by, valid_until)
    values (org_a, site_a1, w_fit, t_height, 'CLEARED', true, true, true, true, u_hseo, now() + interval '12 hours');
    raise exception 'D3 GAGAL: HSE Officer menerbitkan kesiapan';
  exception when insufficient_privilege then null;
  end;
  perform set_config('app.user_id', u_doc::text, true);
  begin
    insert into medical_clearance (organization_id, site_id, worker_id, clearance_type_id, result, history_reviewed,
                                   blood_pressure_checked, vital_signs_checked, vitals_within_limits, examined_by, valid_until)
    values (org_a, site_a1, w_fit, t_height, 'CLEARED', true, false, true, true, u_doc, now() + interval '12 hours');
    raise exception 'D3 GAGAL: SIAP tanpa pengukuran tensi diterima';
  exception when check_violation then null;
  end;
  begin
    insert into medical_clearance (organization_id, site_id, worker_id, clearance_type_id, result, history_reviewed,
                                   blood_pressure_checked, vital_signs_checked, vitals_within_limits, examined_by, valid_until)
    values (org_a, site_a1, w_fit, t_height, 'CLEARED', true, true, true, true, u_doc, now() + interval '30 hours');
    raise exception 'D3 GAGAL: masa berlaku > 24 jam diterima';
  exception when check_violation then null;
  end;
  begin
    insert into medical_clearance (organization_id, site_id, worker_id, clearance_type_id, result, history_reviewed,
                                   blood_pressure_checked, vital_signs_checked, vitals_within_limits, examined_by)
    values (org_a, site_a1, w_fit, t_height, 'NOT_CLEARED', true, true, true, false, u_doc);
    raise exception 'D3 GAGAL: TIDAK SIAP tanpa catatan diterima';
  exception when check_violation then null;
  end;
  checks := checks + 5;

  -- D4 aturan SIAP: MCU UNFIT ditolak; pembatasan NO_WORK_AT_HEIGHT menolak ketinggian tapi tidak ruang terbatas
  begin
    insert into medical_clearance (organization_id, site_id, worker_id, clearance_type_id, result, history_reviewed,
                                   blood_pressure_checked, vital_signs_checked, vitals_within_limits, examined_by, valid_until)
    values (org_a, site_a1, w_unfit, t_height, 'CLEARED', true, true, true, true, u_doc, now() + interval '12 hours');
    raise exception 'D4 GAGAL: SIAP untuk pekerja Unfit diterima';
  exception when check_violation then
    if sqlerrm not like 'MCU_NOT_VALID%' then raise; end if;
  end;
  begin
    insert into medical_clearance (organization_id, site_id, worker_id, clearance_type_id, result, history_reviewed,
                                   blood_pressure_checked, vital_signs_checked, vitals_within_limits, examined_by, valid_until)
    values (org_a, site_a1, w_restr, t_height, 'CLEARED', true, true, true, true, u_doc, now() + interval '12 hours');
    raise exception 'D4 GAGAL: SIAP ketinggian dengan pembatasan ketinggian diterima';
  exception when check_violation then
    if sqlerrm not like 'RESTRICTION_CONFLICT%' then raise; end if;
  end;
  insert into medical_clearance (organization_id, site_id, worker_id, clearance_type_id, result, history_reviewed,
                                 blood_pressure_checked, vital_signs_checked, vitals_within_limits, examined_by, valid_until)
  values (org_a, site_a1, w_restr, t_confined, 'CLEARED', true, true, true, true, u_doc, now() + interval '12 hours');
  -- TIDAK SIAP tetap boleh dicatat untuk pekerja Unfit
  insert into medical_clearance (organization_id, site_id, worker_id, clearance_type_id, result, history_reviewed,
                                 blood_pressure_checked, vital_signs_checked, vitals_within_limits, note, examined_by)
  values (org_a, site_a1, w_unfit, t_height, 'NOT_CLEARED', true, true, true, false, 'Tidak diizinkan bekerja di ketinggian shift ini', u_doc);
  insert into medical_clearance (organization_id, site_id, worker_id, clearance_type_id, result, history_reviewed,
                                 blood_pressure_checked, vital_signs_checked, vitals_within_limits, examined_by, valid_until)
  values (org_a, site_a1, w_fit, t_height, 'CLEARED', true, true, true, true, u_doc, now() + interval '12 hours') returning id into c;
  checks := checks + 4;

  -- D5 hasil tidak dapat diubah; pencabutan hanya Dokter dengan alasan
  begin
    update medical_clearance set result = 'NOT_CLEARED' where id = c;
    raise exception 'D5 GAGAL: hasil diubah';
  exception when check_violation or insufficient_privilege then null;
  end;
  perform set_config('app.user_id', u_hseo::text, true);
  update medical_clearance set revoked_at = now(), revoked_by = u_hseo, revoke_reason = 'x' where id = c;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'D5 GAGAL: HSE Officer mencabut kesiapan'; end if;
  perform set_config('app.user_id', u_doc::text, true);
  begin
    update medical_clearance set revoked_at = now(), revoked_by = u_doc where id = c;
    raise exception 'D5 GAGAL: pencabutan tanpa alasan diterima';
  exception when check_violation then null;
  end;
  checks := checks + 3;

  -- D6 tingkat status: Supervisor melihat hasil dan masa berlaku, bukan checklist; pekerja sendiri; tenant lain tidak
  perform set_config('app.user_id', u_spv::text, true);
  select * into r from app.medical_clearance_status(w_fit) where id = c;
  if not found or not r.active or r.type_code <> 'UJI-HEIGHT' then raise exception 'D6 GAGAL: Supervisor tidak melihat kesiapan aktif'; end if;
  if exists (select 1 from medical_clearance) then raise exception 'D6 GAGAL: Supervisor membaca checklist kesiapan'; end if;
  perform set_config('app.user_id', u_b::text, true);
  if exists (select 1 from app.medical_clearance_status(w_fit)) then raise exception 'D6 GAGAL: tenant lain melihat kesiapan'; end if;
  perform set_config('app.user_id', u_wrk::text, true);
  if exists (select 1 from app.medical_clearance_status(w_fit)) then raise exception 'D6 GAGAL: pekerja melihat kesiapan orang lain'; end if;
  perform set_config('app.user_id', u_doc::text, true);
  update medical_clearance set revoked_at = now(), revoked_by = u_doc, revoke_reason = 'Pekerja melaporkan keluhan' where id = c;
  perform set_config('app.user_id', u_spv::text, true);
  if exists (select 1 from app.medical_clearance_status(w_fit) where id = c) then raise exception 'D6 GAGAL: kesiapan dicabut masih tampil'; end if;
  checks := checks + 5;
  reset role;

  -- D7 audit sensitif tanpa checklist/catatan
  select count(*) into n from audit_outbox where payload->>'entity_id' = c::text
     and payload->>'action' in ('medical.clearance_issue', 'medical.clearance_revoke');
  if n <> 2 then raise exception 'D7 GAGAL: audit kesiapan tidak lengkap (%)', n; end if;
  if exists (select 1 from audit_outbox where payload->>'entity_id' = c::text
             and (payload::text like '%vitals_within_limits%' or payload::text like '%keluhan%')) then
    raise exception 'D7 GAGAL: audit memuat checklist/alasan';
  end if;
  checks := checks + 2;

  raise exception 'HASIL_UJI LULUS: % pemeriksaan Dokter dan kesiapan kerja khusus (perubahan uji dibatalkan)', checks;
end
$test$;

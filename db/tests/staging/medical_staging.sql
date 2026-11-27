-- medical_staging.sql: uji migrasi 0019 + 0020 (B-27 Dokter) untuk Supabase SQL Editor. Data sintetis. Diakhiri exception:
-- semua perubahan dibatalkan.

do $test$
declare
  org_a uuid; u_hseo uuid; u_mgr uuid; u_mo uuid; u_doc uuid; u_spv uuid; u_wrk uuid; u_b uuid;
  site_a1 uuid; site_other uuid; w_team uuid; w_nonteam uuid; w_self uuid; w_other uuid; t_mcu uuid;
  rec uuid; rec2 uuid; f_med uuid; g uuid; r record; n bigint; checks int := 0;
begin
  select id into org_a from organization order by name limit 1;
  select id into u_hseo from user_profile where organization_id = org_a and email like 'hseo1@%';
  select id into u_mgr from user_profile where organization_id = org_a and email like 'hsemgr@%';
  select id into u_mo from user_profile where organization_id = org_a and email like 'medis@%';   -- petugas medis
  select id into u_doc from user_profile where organization_id = org_a and email like 'dokter@%'; -- Dokter (B-27)
  select id into u_spv from user_profile where organization_id = org_a and email like 'spvtim1@%';  -- Supervisor scope Tim
  select id into u_wrk from user_profile where organization_id = org_a and email like 'pekerja1@%';
  select id into u_b from user_profile where organization_id = (select id from organization order by name offset 1 limit 1)
    and email like 'admin@%';
  select scope_id into site_a1 from user_role_assignment where user_id = u_hseo and scope_type = 'SITE' and revoked_at is null limit 1;
  select id into w_self from worker where user_id = u_wrk;
  -- pekerja dalam tim Supervisor dan pekerja Site yang sama di luar tim
  select tm.worker_id into w_team from user_role_assignment ura join team_member tm on tm.team_id = ura.scope_id
   where ura.user_id = u_spv and ura.scope_type = 'TEAM' and ura.revoked_at is null
     and tm.valid_from <= current_date and (tm.valid_until is null or tm.valid_until >= current_date)
     and tm.worker_id <> w_self limit 1;
  select w.id into w_nonteam from worker w where w.site_id = site_a1 and w.worker_status = 'ACTIVE' and w.user_id is null
     and w.id not in (select tm.worker_id from user_role_assignment ura join team_member tm on tm.team_id = ura.scope_id
                      where ura.user_id = u_spv and ura.scope_type = 'TEAM') limit 1;
  select id, site_id into w_other, site_other from worker where organization_id = org_a and site_id <> site_a1 limit 1;
  -- jenis uji sendiri bila seed staging belum ada (dibatalkan bersama blok)
  insert into medical_exam_type (organization_id, name, code, default_validity_months)
  select org_a, 'Uji MCU Sintetis', 'MCU-PERIODIC', 12
   where not exists (select 1 from medical_exam_type where organization_id = org_a and code = 'MCU-PERIODIC' and status = 'ACTIVE');
  select id into t_mcu from medical_exam_type where organization_id = org_a and code = 'MCU-PERIODIC' and status = 'ACTIVE';
  if w_team is null or w_nonteam is null then raise exception 'SETUP GAGAL: pekerja tim/non-tim tidak ditemukan'; end if;

  insert into file_object (organization_id, bucket, object_path, original_name, mime_type, size_bytes, classification, purpose,
                           uploaded_by, scan_status, scanned_at, checksum_sha256)
  values (org_a, 'soh-medical', 'uji/m-clean-' || gen_random_uuid(), 'mcu.pdf', 'application/pdf', 100, 'SENSITIVE',
          'MEDICAL_DOCUMENT', u_hseo, 'CLEAN', now(), repeat('e', 64)) returning id into f_med;

  -- M1 constraint: fitness hanya saat VERIFIED; FIT_WITH_CONDITION wajib tindak lanjut; tinjau ulang hanya UNFIT;
  -- TEMPORARILY_UNFIT dihapus (B-27); pemisahan tugas; rentang tanggal
  begin
    insert into medical_record (organization_id, site_id, worker_id, exam_type_id, examination_date, expiry_date, fitness_status, created_by)
    values (org_a, site_a1, w_team, t_mcu, current_date, current_date + 365, 'FIT', u_hseo);
    raise exception 'M1 GAGAL: fitness tanpa penetapan diterima';
  exception when check_violation then null;
  end;
  begin
    insert into medical_record (organization_id, site_id, worker_id, exam_type_id, examination_date, expiry_date, fitness_status,
                                verification_status, verified_by, verified_at, created_by)
    values (org_a, site_a1, w_team, t_mcu, current_date, current_date + 365, 'FIT_WITH_CONDITION', 'VERIFIED', u_doc, now(), u_hseo);
    raise exception 'M1 GAGAL: FIT_WITH_CONDITION tanpa tindak lanjut diterima';
  exception when check_violation then null;
  end;
  begin
    insert into medical_record (organization_id, site_id, worker_id, exam_type_id, examination_date, expiry_date, fitness_status,
                                unfit_until, verification_status, verified_by, verified_at, created_by)
    values (org_a, site_a1, w_team, t_mcu, current_date, current_date + 365, 'FIT', current_date + 30, 'VERIFIED', u_doc, now(), u_hseo);
    raise exception 'M1 GAGAL: tanggal tinjau ulang pada FIT diterima';
  exception when check_violation then null;
  end;
  begin
    insert into medical_record (organization_id, site_id, worker_id, exam_type_id, examination_date, expiry_date, fitness_status,
                                verification_status, verified_by, verified_at, created_by)
    values (org_a, site_a1, w_team, t_mcu, current_date, current_date + 365, 'TEMPORARILY_UNFIT', 'VERIFIED', u_doc, now(), u_hseo);
    raise exception 'M1 GAGAL: TEMPORARILY_UNFIT masih diterima';
  exception when check_violation then null;
  end;
  begin
    insert into medical_record (organization_id, site_id, worker_id, exam_type_id, examination_date, expiry_date, fitness_status,
                                verification_status, verified_by, verified_at, created_by)
    values (org_a, site_a1, w_team, t_mcu, current_date, current_date + 365, 'FIT', 'VERIFIED', u_doc, now(), u_doc);
    raise exception 'M1 GAGAL: pembuat menetapkan sendiri diterima';
  exception when check_violation then null;
  end;
  begin
    insert into medical_record (organization_id, site_id, worker_id, exam_type_id, examination_date, expiry_date, created_by)
    values (org_a, site_a1, w_team, t_mcu, current_date, current_date - 1, u_hseo);
    raise exception 'M1 GAGAL: expiry sebelum pemeriksaan diterima';
  exception when check_violation then null;
  end;
  checks := checks + 6;

  -- M2 HSE Officer (medical.update LIMITED): mencatat administratif di Site-nya, tidak menetapkan, tidak Site lain
  set local role app_authenticated;
  perform set_config('app.user_id', u_hseo::text, true);
  insert into medical_record (organization_id, site_id, worker_id, exam_type_id, examination_date, expiry_date, provider, file_id, created_by)
  values (org_a, site_a1, w_team, t_mcu, current_date - 2, current_date + 363, 'Klinik Sintetis', f_med, u_hseo) returning id into rec;
  begin
    insert into medical_record (organization_id, site_id, worker_id, exam_type_id, examination_date, expiry_date, created_by)
    values (org_a, site_other, w_other, t_mcu, current_date, current_date + 365, u_hseo);
    raise exception 'M2 GAGAL: pencatatan di Site lain diterima';
  exception when insufficient_privilege then null;
  end;
  begin
    update medical_record set verification_status = 'VERIFIED', fitness_status = 'FIT', verified_by = u_hseo, verified_at = now()
     where id = rec;
    raise exception 'M2 GAGAL: HSE Officer menetapkan Fit to Work';
  exception when check_violation or insufficient_privilege then null;
  end;
  if not exists (select 1 from medical_record where id = rec) then raise exception 'M2 GAGAL: pencatat tidak melihat record buatannya'; end if;
  if exists (select 1 from medical_record where verification_status = 'VERIFIED') then
    raise exception 'M2 GAGAL: HSE Officer melihat detail record yang sudah ditetapkan';
  end if;
  checks := checks + 4;

  -- M3 petugas medis (Medical Officer) tidak lagi menetapkan; Dokter menetapkan FIT_WITH_RESTRICTION + pembatasan;
  -- HSE Officer tidak menambah pembatasan
  perform set_config('app.user_id', u_mo::text, true);
  begin
    update medical_record set verification_status = 'VERIFIED', fitness_status = 'FIT', verified_by = u_mo, verified_at = now()
     where id = rec;
    raise exception 'M3 GAGAL: Medical Officer menetapkan Fit to Work';
  exception when insufficient_privilege then null;
  end;
  perform set_config('app.user_id', u_doc::text, true);
  update medical_record set verification_status = 'VERIFIED', fitness_status = 'FIT_WITH_RESTRICTION', verified_by = u_doc,
         verified_at = now(), determination_comment = 'Evaluasi ulang 6 bulan' where id = rec;
  insert into medical_restriction (organization_id, medical_record_id, restriction_code, operational_description, valid_from, valid_until, created_by)
  values (org_a, rec, 'NO_WORK_AT_HEIGHT', 'Tidak bekerja di ketinggian di atas 2 meter', current_date - 2, current_date + 180, u_doc);
  begin
    update medical_record set verification_status = 'REJECTED', verified_by = u_doc, rejection_reason = 'x' where id = rec;
    raise exception 'M3 GAGAL: penetapan diubah langsung menjadi penolakan';
  exception when check_violation then null;
  end;
  perform set_config('app.user_id', u_hseo::text, true);
  begin
    insert into medical_restriction (organization_id, medical_record_id, restriction_code, operational_description, valid_from, created_by)
    values (org_a, rec, 'NO_NIGHT_SHIFT', 'Tidak bekerja shift malam', current_date, u_hseo);
    raise exception 'M3 GAGAL: HSE Officer menambah pembatasan';
  exception when insufficient_privilege then null;
  end;
  if exists (select 1 from medical_record where id = rec) then raise exception 'M3 GAGAL: pencatat masih melihat detail setelah ditetapkan'; end if;
  if exists (select 1 from file_object where id = f_med and uploaded_by <> u_hseo) then raise exception 'M3 GAGAL: setup berkas'; end if;
  checks := checks + 4;

  -- M4 tingkat status: Supervisor tim melihat status + pembatasan operasional, bukan detail; bukan pekerja luar tim
  perform set_config('app.user_id', u_spv::text, true);
  select * into r from app.medical_status(w_team);
  if r.fitness_status is distinct from 'FIT_WITH_RESTRICTION' or jsonb_array_length(r.restrictions) <> 1
     or r.restrictions->0->>'restriction_code' <> 'NO_WORK_AT_HEIGHT' then
    raise exception 'M4 GAGAL: Supervisor tidak melihat status/pembatasan timnya (%)', r;
  end if;
  if exists (select 1 from medical_record) or exists (select 1 from medical_restriction) then
    raise exception 'M4 GAGAL: Supervisor membaca tabel detail medis';
  end if;
  if exists (select 1 from app.medical_status(w_nonteam)) then raise exception 'M4 GAGAL: Supervisor melihat status di luar timnya'; end if;
  if exists (select 1 from file_object where id = f_med) then raise exception 'M4 GAGAL: Supervisor melihat dokumen MCU'; end if;
  perform set_config('app.user_id', u_b::text, true);
  if exists (select 1 from app.medical_status(w_team)) then raise exception 'M4 GAGAL: tenant lain melihat status medis'; end if;
  perform set_config('app.user_id', u_hseo::text, true);
  if (select validity_status from app.medical_status(w_team)) is distinct from 'VALID' then
    raise exception 'M4 GAGAL: HSE Officer Site tidak melihat status';
  end if;
  checks := checks + 6;

  -- M5 pekerja sendiri: status dan detail miliknya saja
  perform set_config('app.user_id', u_wrk::text, true);
  if not exists (select 1 from app.medical_status(w_self)) then raise exception 'M5 GAGAL: pekerja tidak melihat status dirinya'; end if;
  if exists (select 1 from app.medical_status(w_team)) then raise exception 'M5 GAGAL: pekerja melihat status orang lain'; end if;
  if exists (select 1 from medical_record where worker_id <> w_self) then raise exception 'M5 GAGAL: pekerja melihat detail orang lain'; end if;
  checks := checks + 3;

  -- M6 HSE Manager: tanpa otorisasi tidak melihat detail; otorisasi dari Dokter (<= 24 jam) membuka satu record
  perform set_config('app.user_id', u_mgr::text, true);
  if exists (select 1 from medical_record) then raise exception 'M6 GAGAL: HSE Manager melihat detail tanpa otorisasi'; end if;
  perform set_config('app.user_id', u_doc::text, true);
  begin
    insert into medical_access_grant (organization_id, medical_record_id, grantee_user_id, granted_by, reason, expires_at)
    values (org_a, rec, u_mgr, u_doc, 'Investigasi sintetis', now() + interval '25 hours');
    raise exception 'M6 GAGAL: otorisasi > 24 jam diterima';
  exception when check_violation then null;
  end;
  begin
    insert into medical_access_grant (organization_id, medical_record_id, grantee_user_id, granted_by, reason, expires_at)
    values (org_a, rec, u_spv, u_doc, 'Bukan HSE Manager', now() + interval '1 hour');
    raise exception 'M6 GAGAL: penerima tidak berhak diterima';
  exception when check_violation then null;
  end;
  insert into medical_access_grant (organization_id, medical_record_id, grantee_user_id, granted_by, reason, expires_at)
  values (org_a, rec, u_mgr, u_doc, 'Investigasi insiden sintetis', now() + interval '2 hours') returning id into g;
  perform set_config('app.user_id', u_hseo::text, true);
  begin
    insert into medical_access_grant (organization_id, medical_record_id, grantee_user_id, granted_by, reason, expires_at)
    values (org_a, rec, u_mgr, u_hseo, 'HSE Officer memberi akses', now() + interval '1 hour');
    raise exception 'M6 GAGAL: HSE Officer memberi otorisasi';
  exception when insufficient_privilege then null;
  end;
  perform set_config('app.user_id', u_mgr::text, true);
  select count(*) into n from medical_record;
  if n <> 1 or not exists (select 1 from medical_record where id = rec) then raise exception 'M6 GAGAL: otorisasi tidak membuka tepat satu record'; end if;
  if not exists (select 1 from file_object where id = f_med) then raise exception 'M6 GAGAL: dokumen tidak terbuka dengan otorisasi'; end if;
  perform set_config('app.user_id', u_doc::text, true);
  update medical_access_grant set revoked_at = now() where id = g;
  perform set_config('app.user_id', u_mgr::text, true);
  if exists (select 1 from medical_record) then raise exception 'M6 GAGAL: otorisasi dicabut masih membuka detail'; end if;
  checks := checks + 7;

  -- M7 data inti berubah setelah ditetapkan -> PENDING, Fit to Work dikosongkan, pembatasan diakhiri
  perform set_config('app.user_id', u_mo::text, true);
  update medical_record set expiry_date = expiry_date - 30 where id = rec;
  if (select verification_status from medical_record where id = rec) <> 'PENDING'
     or (select fitness_status from medical_record where id = rec) is not null
     or exists (select 1 from medical_restriction where medical_record_id = rec and status = 'ACTIVE') then
    raise exception 'M7 GAGAL: perubahan data inti tidak mengembalikan ke PENDING';
  end if;
  perform set_config('app.user_id', u_spv::text, true);
  if (select fitness_status from app.medical_status(w_team)) is distinct from
     (select fitness_status from medical_record where worker_id = w_team and verification_status = 'VERIFIED' and id <> rec
      order by examination_date desc limit 1) then
    null; -- status kembali ke record terverifikasi sebelumnya (bila ada); dicek lewat validity di bawah
  end if;
  if (select validity_status from app.medical_status(w_team)) = 'VALID'
     and (select fitness_status from app.medical_status(w_team)) = 'FIT_WITH_RESTRICTION' then
    raise exception 'M7 GAGAL: status masih memakai penetapan yang dikosongkan';
  end if;
  checks := checks + 2;
  reset role;

  -- M8 audit: tanpa nilai Fit to Work di payload; aksi lengkap
  select count(distinct payload->>'action') into n from audit_outbox where payload->>'entity_id' = rec::text
     and payload->>'action' in ('medical.create', 'medical.verify', 'medical.restriction_add', 'medical.access_grant',
                                'medical.access_grant_revoke', 'medical.resubmit');
  if n <> 6 then raise exception 'M8 GAGAL: audit medis tidak lengkap (% dari 6)', n; end if;
  if exists (select 1 from audit_outbox where payload->>'entity_id' = rec::text
             and (payload::text like '%FIT_WITH_RESTRICTION%' or payload::text like '%Tidak bekerja di ketinggian%')) then
    raise exception 'M8 GAGAL: audit memuat nilai medis';
  end if;
  checks := checks + 2;

  raise exception 'HASIL_UJI LULUS: % pemeriksaan Medical (perubahan uji dibatalkan)', checks;
end
$test$;

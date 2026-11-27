-- readiness_engine.sql: uji migrasi 0023 (SRS-RE v1.2.1, DB-005, B-30): Requirement Profile berversi, engine
-- deterministik, pemicu outbox, evaluasi terjadwal dan manual, RLS dan penyamaran medis. Data sintetis.
-- Semua perubahan dibatalkan. Keluaran akhir: NOTICE "LULUS".
\set ON_ERROR_STOP on

begin;

do $test$
declare
  org_a uuid; site_a1 uuid; site_tz text; today date;
  u_adm uuid; u_mgr uuid; u_hseo uuid; u_spvtim uuid; u_mo uuid; u_doc uuid; u_wrk uuid; u_b uuid;
  w_a uuid; w_b uuid; w_c uuid; w_d uuid; w_e uuid; w_self uuid;
  pos uuid; cmp uuid; atype uuid; stype uuid; eclass uuid; t_mcu uuid;
  prof uuid; prof2 uuid; item_med uuid; snap uuid; snap2 uuid; rec uuid; smp uuid;
  workers uuid[]; cmp_days int[] := array[200, 10, 200, 200, 200]; fitness text[];
  i int; w uuid; wsite uuid; r record; n bigint; v int; checks int := 0;
begin
  select id into org_a from organization order by name limit 1;
  select id, timezone into site_a1, site_tz from site where organization_id = org_a and code = 'SITE-1';
  today := app.site_today(site_a1);
  select id into u_adm from user_profile where organization_id = org_a and email like 'admin@%';
  select id into u_mgr from user_profile where organization_id = org_a and email like 'hsemgr@%';
  select id into u_hseo from user_profile where organization_id = org_a and email like 'hseo1@%';
  select id into u_spvtim from user_profile where organization_id = org_a and email like 'spvtim1@%';
  select id into u_mo from user_profile where organization_id = org_a and email like 'medis@%';
  select id into u_doc from user_profile where organization_id = org_a and email like 'dokter@%';
  select id into u_wrk from user_profile where organization_id = org_a and email like 'pekerja1@%';
  select id into u_b from user_profile where organization_id = (select id from organization order by name offset 1 limit 1)
    and email like 'admin@%';
  select id into w_self from worker where user_id = u_wrk;
  -- empat pekerja dalam tim Supervisor Tim (Site 1), satu pekerja Site 1 di luar tim
  select array_agg(x.worker_id) into workers from (
    select tm.worker_id from team_member tm join team t on t.id = tm.team_id join worker wk on wk.id = tm.worker_id
     where t.site_id = site_a1 and t.code = 'TIM-PROD' and wk.worker_status = 'ACTIVE' and wk.user_id is null
     order by tm.worker_id limit 4) x;
  w_a := workers[1]; w_b := workers[2]; w_c := workers[3]; w_d := workers[4];
  select wk.id into w_e from worker wk where wk.site_id = site_a1 and wk.worker_status = 'ACTIVE' and wk.user_id is null
    and not exists (select 1 from team_member tm join team t on t.id = tm.team_id where tm.worker_id = wk.id and t.code = 'TIM-PROD')
    order by wk.id limit 1;
  if w_d is null or w_e is null or w_self is null then raise exception 'PRASYARAT GAGAL: pekerja uji tidak lengkap'; end if;

  insert into job_position (organization_id, name, code, job_family) values (org_a, 'Uji Readiness', 'UJI-RE', 'Umum')
    returning id into pos;
  insert into competency (organization_id, name, code) values (org_a, 'Uji RE Kompetensi', 'UJI-RE-CMP') returning id into cmp;
  insert into authorization_type (organization_id, name, code) values (org_a, 'Uji RE Otorisasi', 'UJI-RE-OTO') returning id into atype;
  insert into simper_type (organization_id, name, code) values (org_a, 'Uji RE SIMPER', 'UJI-RE-SMP') returning id into stype;
  insert into medical_exam_type (organization_id, name, code) values (org_a, 'Uji RE MCU', 'UJI-RE-MCU') returning id into t_mcu;
  select id into eclass from equipment_class where organization_id = org_a and code = 'DT';
  update worker set job_position_id = pos where id in (w_a, w_b, w_c, w_d, w_e, w_self);

  -- antrean awal (seed) diproses agar hitungan berikutnya jelas
  update readiness_outbox set created_at = created_at - interval '1 minute' where status = 'PENDING';
  set local role app_worker;
  perform app.readiness_process(100000);
  reset role;

  -- E1 tanpa profile aktif: NOT_READY PROFILE_NOT_SET (FR-RE-003)
  select rc.status, rs.reason_code, rs.rule_version into r from readiness_current rc
    join readiness_snapshot rs on rs.id = rc.snapshot_id where rc.worker_id = w_a;
  if r.status is distinct from 'NOT_READY' or r.reason_code is distinct from 'PROFILE_NOT_SET' or r.rule_version is distinct from 'RE-1' then
    raise exception 'E1 GAGAL: tanpa profile status %/% (rule %)', r.status, r.reason_code, r.rule_version;
  end if;
  checks := checks + 1;

  -- E2 Requirement Profile: hanya readiness_profile.manage tingkat organisasi; DRAFT -> ACTIVE; kosong ditolak;
  -- syarat valid tepat satu referensi; ACTIVE terkunci
  set local role app_authenticated;
  perform set_config('app.user_id', u_hseo::text, true);
  begin
    insert into requirement_profile (organization_id, job_position_id, profile_version) values (org_a, pos, 1);
    raise exception 'E2 GAGAL: HSE Officer membuat profile';
  exception when insufficient_privilege then null;
  end;
  perform set_config('app.user_id', u_mgr::text, true);
  insert into requirement_profile (organization_id, job_position_id, profile_version, notes)
    values (org_a, pos, 1, 'Profile uji') returning id into prof;
  begin
    update requirement_profile set status = 'ACTIVE' where id = prof;
    raise exception 'E2 GAGAL: profile kosong diaktifkan';
  exception when check_violation then
    if sqlerrm not like 'PROFILE_EMPTY%' then raise; end if;
  end;
  insert into requirement_profile_item (organization_id, profile_id, item_type, competency_id, display_order)
    values (org_a, prof, 'COMPETENCY', cmp, 1);
  insert into requirement_profile_item (organization_id, profile_id, item_type, authorization_type_id, display_order)
    values (org_a, prof, 'AUTHORIZATION', atype, 2);
  insert into requirement_profile_item (organization_id, profile_id, item_type, simper_type_id, equipment_class_id, display_order)
    values (org_a, prof, 'SIMPER', stype, eclass, 3);
  insert into requirement_profile_item (organization_id, profile_id, item_type, medical_exam_type_id, display_order)
    values (org_a, prof, 'MEDICAL', t_mcu, 4) returning id into item_med;
  begin
    insert into requirement_profile_item (organization_id, profile_id, item_type, competency_id, medical_exam_type_id)
      values (org_a, prof, 'COMPETENCY', cmp, t_mcu);
    raise exception 'E2 GAGAL: syarat dengan dua referensi diterima';
  exception when check_violation then null;
  end;
  begin
    insert into requirement_profile_item (organization_id, profile_id, item_type, competency_id) values (org_a, prof, 'COMPETENCY', cmp);
    raise exception 'E2 GAGAL: syarat ganda diterima';
  exception when unique_violation then null;
  end;
  update requirement_profile set status = 'ACTIVE' where id = prof;
  select * into r from requirement_profile where id = prof;
  if r.status is distinct from 'ACTIVE' or r.activated_by is distinct from u_mgr or r.activated_at is null then
    raise exception 'E2 GAGAL: aktivasi tidak tercatat (%/%)', r.status, r.activated_by;
  end if;
  begin
    insert into requirement_profile_item (organization_id, profile_id, item_type, authorization_type_id, is_mandatory)
      values (org_a, prof, 'AUTHORIZATION', (select id from authorization_type where organization_id = org_a and code = 'AUTH-HEIGHT'), false);
    raise exception 'E2 GAGAL: syarat ditambahkan ke profile ACTIVE';
  exception when check_violation then
    if sqlerrm not like 'PROFILE_LOCKED%' then raise; end if;
  end;
  begin
    update requirement_profile set notes = 'ubah' where id = prof;
    raise exception 'E2 GAGAL: profile ACTIVE diubah';
  exception when check_violation then null;
  end;
  delete from requirement_profile where id = prof;
  if not exists (select 1 from requirement_profile where id = prof) then raise exception 'E2 GAGAL: profile ACTIVE terhapus'; end if;
  reset role;
  if not exists (select 1 from readiness_outbox where event_type = 'PROFILE_ACTIVATED' and payload->>'profile_id' = prof::text) then
    raise exception 'E2 GAGAL: aktivasi tidak memicu evaluasi';
  end if;
  if not exists (select 1 from audit_outbox where payload->>'entity_id' = prof::text and payload->>'action' like 'requirement_profile.%') then
    raise exception 'E2 GAGAL: perubahan profile tidak teraudit';
  end if;
  checks := checks + 10;

  -- data syarat pekerja: B semua valid; C kompetensi segera berakhir; D otorisasi dibekukan; E MCU UNFIT;
  -- pekerja sendiri FIT_WITH_RESTRICTION dengan pembatasan aktif
  fitness := array['FIT', 'FIT', 'FIT', 'UNFIT', 'FIT_WITH_RESTRICTION'];
  workers := array[w_b, w_c, w_d, w_e, w_self];
  for i in 1 .. 5 loop
    w := workers[i];
    select site_id into wsite from worker where id = w;
    insert into worker_competency (organization_id, site_id, worker_id, competency_id, valid_from, valid_until, created_by,
                                   verification_status, verified_by, verified_at)
    values (org_a, wsite, w, cmp, today - 100, today + cmp_days[i], u_hseo, 'VERIFIED', u_mgr, now());
    insert into worker_authorization (organization_id, site_id, worker_id, authorization_type_id, valid_from, valid_until,
                                      created_by, verification_status, verified_by, verified_at)
    values (org_a, wsite, w, atype, today - 100, today + 200, u_hseo, 'VERIFIED', u_mgr, now());
    insert into simper (organization_id, site_id, worker_id, simper_type_id, valid_from, valid_until, created_by)
    values (org_a, wsite, w, stype, today - 100, today + 200, u_hseo) returning id into smp;
    insert into simper_authorization (organization_id, simper_id, equipment_class_id, valid_from, valid_until, created_by)
    values (org_a, smp, eclass, today - 100, today + 200, u_hseo);
    update simper set verification_status = 'VERIFIED', verified_by = u_mgr, verified_at = now() where id = smp;
    insert into medical_record (organization_id, site_id, worker_id, exam_type_id, examination_date, expiry_date, created_by)
    values (org_a, wsite, w, t_mcu, today - 10, today + 200, u_hseo) returning id into rec;
    perform set_config('app.user_id', u_doc::text, true);
    update medical_record set verification_status = 'VERIFIED', verified_by = u_doc, verified_at = now(), fitness_status = fitness[i]
     where id = rec;
    if fitness[i] = 'FIT_WITH_RESTRICTION' then
      insert into medical_restriction (organization_id, medical_record_id, restriction_code, operational_description, valid_from,
                                       valid_until, created_by)
      values (org_a, rec, 'NO_NIGHT_SHIFT', 'Tidak bekerja pada sif malam', today - 10, today + 60, u_doc);
    end if;
  end loop;
  -- B: record lama yang sudah kedaluwarsa tidak menghapus jadwal evaluasi record yang berlaku
  insert into worker_competency (organization_id, site_id, worker_id, competency_id, valid_from, valid_until, created_by,
                                 verification_status, verified_by, verified_at)
  values (org_a, site_a1, w_b, cmp, today - 800, today - 5, u_hseo, 'VERIFIED', u_mgr, now());
  -- D: otorisasi kedua yang valid tidak menutup pembekuan aktif (SRS-RE 6.3)
  perform set_config('app.user_id', u_mgr::text, true);
  update worker_authorization set suspension_status = 'SUSPENDED', suspension_reason = 'Uji pembekuan', suspended_by = u_mgr,
         suspended_at = now() where worker_id = w_d and authorization_type_id = atype;
  insert into worker_authorization (organization_id, site_id, worker_id, authorization_type_id, valid_from, valid_until,
                                    created_by, verification_status, verified_by, verified_at)
  values (org_a, site_a1, w_d, atype, today - 5, today + 300, u_hseo, 'VERIFIED', u_mgr, now());

  -- debounce: peristiwa < 5 detik belum diproses (SRS-RE 7.2)
  set local role app_worker;
  select events into v from app.readiness_process(100000) where true;
  reset role;
  if v <> 0 then raise exception 'E3 GAGAL: peristiwa baru diproses sebelum debounce (% peristiwa)', v; end if;
  update readiness_outbox set created_at = created_at - interval '1 minute' where status = 'PENDING';
  set local role app_worker;
  select * into r from app.readiness_process(100000);
  reset role;
  if r.failed is distinct from 0 or r.workers < 6 then raise exception 'E3 GAGAL: pemrosesan % pekerja, % gagal', r.workers, r.failed; end if;
  if exists (select 1 from readiness_outbox where status <> 'DONE') then raise exception 'E3 GAGAL: antrean tersisa'; end if;
  checks := checks + 3;

  -- E4 A tanpa record: semua MISSING, NOT_READY, skor 0, dipicu perubahan profile
  select rc.status, rc.score, rs.trigger_type, rs.profile_version into r from readiness_current rc
    join readiness_snapshot rs on rs.id = rc.snapshot_id where rc.worker_id = w_a;
  if r.status is distinct from 'NOT_READY' or r.score is distinct from 0 or r.trigger_type is distinct from 'PROFILE_CHANGE' or r.profile_version is distinct from 1 then
    raise exception 'E4 GAGAL: A %/%/%/%', r.status, r.score, r.trigger_type, r.profile_version;
  end if;
  select count(*) into n from readiness_snapshot_item i join readiness_current rc on rc.snapshot_id = i.snapshot_id
   where rc.worker_id = w_a and i.requirement_status = 'MISSING' and i.reason_code = 'MISSING';
  if n <> 4 then raise exception 'E4 GAGAL: % syarat MISSING, harus 4', n; end if;
  checks := checks + 2;

  -- E5 B semua valid: READY 100, evaluasi berikutnya = awal hari lokal (berakhir - warning_days)
  select * into r from readiness_current where worker_id = w_b;
  if r.status is distinct from 'READY' or r.score is distinct from 100 then raise exception 'E5 GAGAL: B %/%', r.status, r.score; end if;
  if r.next_evaluation_at is distinct from ((today + 170)::timestamp at time zone site_tz) then
    raise exception 'E5 GAGAL: next_evaluation_at % (harus awal hari H+170 %)', r.next_evaluation_at, site_tz;
  end if;
  checks := checks + 2;

  -- E6 C kompetensi H-10: CONDITIONAL, EXPIRING_SOON, evaluasi berikutnya = sehari setelah berakhir
  select * into r from readiness_current where worker_id = w_c;
  if r.status is distinct from 'CONDITIONAL' or r.score is distinct from 100 then raise exception 'E6 GAGAL: C %/%', r.status, r.score; end if;
  if r.next_evaluation_at is distinct from ((today + 11)::timestamp at time zone site_tz) then
    raise exception 'E6 GAGAL: next_evaluation_at %', r.next_evaluation_at;
  end if;
  if not exists (select 1 from readiness_snapshot_item where snapshot_id = r.snapshot_id and item_type = 'COMPETENCY'
                   and requirement_status = 'EXPIRING_SOON' and expiry_date = today + 10) then
    raise exception 'E6 GAGAL: item kompetensi bukan EXPIRING_SOON';
  end if;
  checks := checks + 3;

  -- E7 D pembekuan aktif: SUSPENDED walau ada otorisasi lain yang valid -> NOT_READY
  select * into r from readiness_current where worker_id = w_d;
  if r.status is distinct from 'NOT_READY' or not exists (select 1 from readiness_snapshot_item where snapshot_id = r.snapshot_id
       and item_type = 'AUTHORIZATION' and requirement_status = 'SUSPENDED') then
    raise exception 'E7 GAGAL: D % tanpa item SUSPENDED', r.status;
  end if;
  checks := checks + 1;

  -- E8 E MCU UNFIT: item medis SUSPENDED/MEDICAL_UNFIT, sensitif, NOT_READY
  select * into r from readiness_current where worker_id = w_e;
  if r.status is distinct from 'NOT_READY' or not exists (select 1 from readiness_snapshot_item where snapshot_id = r.snapshot_id
       and item_type = 'MEDICAL' and requirement_status = 'SUSPENDED' and reason_code = 'MEDICAL_UNFIT' and is_sensitive) then
    raise exception 'E8 GAGAL: E % tanpa item medis UNFIT', r.status;
  end if;
  checks := checks + 1;

  -- E9 pekerja sendiri FIT_WITH_RESTRICTION aktif: RESTRICTED -> CONDITIONAL, skor 75/90 = 83
  select * into r from readiness_current where worker_id = w_self;
  if r.status is distinct from 'CONDITIONAL' or r.score is distinct from 83 then raise exception 'E9 GAGAL: pekerja %/%', r.status, r.score; end if;
  if r.next_evaluation_at is distinct from ((today + 61)::timestamp at time zone
       (select timezone from site where id = (select site_id from worker where id = w_self))) then
    raise exception 'E9 GAGAL: berakhirnya pembatasan tidak dijadwalkan (%)', r.next_evaluation_at;
  end if;
  checks := checks + 2;

  -- E10 hash: evaluasi ulang tanpa perubahan tidak membuat snapshot baru (SRS-RE 6.6)
  select count(*), max(rc.version) into n, v from readiness_snapshot rs join readiness_current rc on rc.worker_id = rs.worker_id
   where rs.worker_id = w_b group by rc.version;
  snap := app.readiness_evaluate(w_b, 'MANUAL', null);
  if snap is distinct from (select snapshot_id from readiness_current where worker_id = w_b)
     or (select count(*) from readiness_snapshot where worker_id = w_b) <> n
     or (select version from readiness_current where worker_id = w_b) is distinct from v + 1 then
    raise exception 'E10 GAGAL: evaluasi ulang tanpa perubahan membuat snapshot baru';
  end if;
  checks := checks + 1;

  -- E11 SIMPER kelas alat dibekukan lewat trigger: B tidak lagi READY; previous_status tercatat
  perform set_config('app.user_id', u_mgr::text, true);
  update simper_authorization set status = 'SUSPENDED', status_reason = 'Uji kelas alat', status_changed_by = u_mgr,
         status_changed_at = now()
   where simper_id = (select id from simper where worker_id = w_b and simper_type_id = stype);
  update readiness_outbox set created_at = created_at - interval '1 minute' where status = 'PENDING';
  set local role app_worker;
  perform app.readiness_process(100000);
  reset role;
  select rc.status, rs.previous_status, rs.trigger_type, rc.snapshot_id into r from readiness_current rc
    join readiness_snapshot rs on rs.id = rc.snapshot_id where rc.worker_id = w_b;
  if r.status is distinct from 'NOT_READY' or r.previous_status is distinct from 'READY' or r.trigger_type is distinct from 'EVENT' then
    raise exception 'E11 GAGAL: B %/% (%)', r.status, r.previous_status, r.trigger_type;
  end if;
  if not exists (select 1 from readiness_snapshot_item where snapshot_id = r.snapshot_id and item_type = 'SIMPER'
                   and requirement_status in ('SUSPENDED', 'PENDING_VERIFICATION')) then
    raise exception 'E11 GAGAL: item SIMPER tidak berubah';
  end if;
  checks := checks + 2;

  -- E12 pekerja nonaktif: NOT_READY WORKER_INACTIVE
  update worker set worker_status = 'INACTIVE' where id = w_a;
  update readiness_outbox set created_at = created_at - interval '1 minute' where status = 'PENDING';
  set local role app_worker;
  perform app.readiness_process(100000);
  reset role;
  if (select rs.reason_code from readiness_current rc join readiness_snapshot rs on rs.id = rc.snapshot_id where rc.worker_id = w_a)
     is distinct from 'WORKER_INACTIVE' then
    raise exception 'E12 GAGAL: pekerja nonaktif bukan WORKER_INACTIVE';
  end if;
  checks := checks + 1;

  -- E13 append-only: snapshot tidak dapat diubah atau dihapus, bahkan oleh pemilik
  begin
    update readiness_snapshot set score = 1 where worker_id = w_b;
    raise exception 'E13 GAGAL: snapshot diubah';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from readiness_snapshot_item where snapshot_id = (select snapshot_id from readiness_current where worker_id = w_b);
    raise exception 'E13 GAGAL: item snapshot dihapus';
  exception when insufficient_privilege then null;
  end;
  checks := checks + 2;

  -- E14 RLS baca: tim, diri sendiri, tenant lain
  set local role app_authenticated;
  perform set_config('app.user_id', u_spvtim::text, true);
  select count(*) into n from readiness_current where worker_id in (w_a, w_b, w_c, w_d);
  if n <> 4 then raise exception 'E14 GAGAL: Supervisor Tim melihat % dari 4 anggota tim', n; end if;
  if exists (select 1 from readiness_current where worker_id in (w_e, w_self)) then
    raise exception 'E14 GAGAL: Supervisor Tim melihat pekerja di luar timnya';
  end if;
  if not exists (select 1 from requirement_profile where id = prof) then raise exception 'E14 GAGAL: Supervisor tidak melihat profile'; end if;
  perform set_config('app.user_id', u_wrk::text, true);
  select count(*) into n from readiness_current;
  if n <> 1 or not exists (select 1 from readiness_current where worker_id = w_self) then
    raise exception 'E14 GAGAL: pekerja melihat % baris kesiapan', n;
  end if;
  if exists (select 1 from requirement_profile) then raise exception 'E14 GAGAL: pekerja melihat Requirement Profile'; end if;
  perform set_config('app.user_id', u_b::text, true);
  if exists (select 1 from readiness_current where organization_id = org_a)
     or exists (select 1 from readiness_snapshot where organization_id = org_a)
     or exists (select 1 from requirement_profile where organization_id = org_a) then
    raise exception 'E14 GAGAL: kesiapan terlihat lintas tenant';
  end if;
  begin
    perform 1 from readiness_snapshot_item limit 1;
    raise exception 'E14 GAGAL: item snapshot dapat dibaca langsung';
  exception when insufficient_privilege then null;
  end;
  checks := checks + 7;

  -- E15 penyamaran medis (SRS-RE 10): HSE Officer dan HSE Manager (detail LIMITED) melihat NOT_MET; Medical Officer
  -- dan Dokter melihat status asli; pekerja melihat dirinya sendiri; RESTRICTED tidak disamarkan
  reset role;
  snap := (select snapshot_id from readiness_current where worker_id = w_e);
  snap2 := (select snapshot_id from readiness_current where worker_id = w_self);
  rec := (select snapshot_id from readiness_current where worker_id = w_c);
  set local role app_authenticated;
  foreach w in array array[u_hseo, u_mgr] loop
    perform set_config('app.user_id', w::text, true);
    select * into r from app.readiness_items(snap) where item_type = 'MEDICAL';
    if r.requirement_status is distinct from 'NOT_MET' or r.reason_code is distinct from 'MEDICAL_REQUIREMENT_NOT_MET' or r.masked is not true
       or r.source_record_id is not null or r.expiry_date is not null then
      raise exception 'E15 GAGAL: medis tidak disamarkan bagi % (%/%)', w, r.requirement_status, r.reason_code;
    end if;
    if (select count(*) from app.readiness_items(snap)) <> 4 then raise exception 'E15 GAGAL: item tidak lengkap bagi % (%)', w, (select count(*) from app.readiness_items(snap)); end if;
  end loop;
  foreach w in array array[u_mo, u_doc] loop
    perform set_config('app.user_id', w::text, true);
    select * into r from app.readiness_items(snap) where item_type = 'MEDICAL';
    if r.requirement_status is distinct from 'SUSPENDED' or r.reason_code is distinct from 'MEDICAL_UNFIT' or r.masked is not false then
      raise exception 'E15 GAGAL: peran medis % melihat %', w, r.requirement_status;
    end if;
  end loop;
  perform set_config('app.user_id', u_wrk::text, true);
  if exists (select 1 from app.readiness_items(snap)) then raise exception 'E15 GAGAL: pekerja melihat item orang lain'; end if;
  select * into r from app.readiness_items(snap2) where item_type = 'MEDICAL';
  if r.requirement_status is distinct from 'RESTRICTED' or r.masked is not false then raise exception 'E15 GAGAL: pekerja melihat medis dirinya %', r.requirement_status; end if;
  perform set_config('app.user_id', u_hseo::text, true);
  select * into r from app.readiness_items(rec) where item_type = 'MEDICAL';
  if r.requirement_status is distinct from 'VALID' or r.masked is not false then raise exception 'E15 GAGAL: medis VALID disamarkan'; end if;
  checks := checks + 7;

  -- E16 evaluasi ulang manual: readiness.evaluate pada Site pekerja, teraudit; selain itu ditolak
  perform set_config('app.user_id', u_hseo::text, true);
  snap2 := app.readiness_evaluate_manual(w_c);
  if snap2 is null then raise exception 'E16 GAGAL: evaluasi manual tidak mengembalikan snapshot'; end if;
  foreach w in array array[u_spvtim, u_wrk] loop
    perform set_config('app.user_id', w::text, true);
    begin
      perform app.readiness_evaluate_manual(w_c);
      raise exception 'E16 GAGAL: % mengevaluasi ulang tanpa readiness.evaluate', w;
    exception when insufficient_privilege then null;
    end;
  end loop;
  perform set_config('app.user_id', u_hseo::text, true);
  begin
    perform app.readiness_evaluate_manual(w_self);
    raise exception 'E16 GAGAL: HSE Officer Site 1 mengevaluasi pekerja Site lain';
  exception when insufficient_privilege then null;
  end;
  perform set_config('app.user_id', u_b::text, true);
  begin
    perform app.readiness_evaluate_manual(w_c);
    raise exception 'E16 GAGAL: tenant lain mengevaluasi ulang';
  exception when no_data_found then null;
  end;
  reset role;
  if not exists (select 1 from audit_outbox where payload->>'action' = 'readiness.evaluate' and payload->>'entity_id' = w_c::text) then
    raise exception 'E16 GAGAL: evaluasi manual tidak teraudit';
  end if;
  checks := checks + 5;

  -- E17 evaluasi terjadwal: yang jatuh tempo dievaluasi dan dijadwalkan ulang; pekerja tanpa hasil ikut dievaluasi
  update readiness_current set next_evaluation_at = now() - interval '1 minute' where worker_id = w_c;
  delete from readiness_current where worker_id = w_d;
  set local role app_worker;
  v := app.readiness_evaluate_due(100000);
  reset role;
  if v < 2 then raise exception 'E17 GAGAL: % pekerja dievaluasi', v; end if;
  if (select next_evaluation_at from readiness_current where worker_id = w_c) is distinct from ((today + 11)::timestamp at time zone site_tz) then
    raise exception 'E17 GAGAL: jadwal evaluasi tidak diperbarui';
  end if;
  if not exists (select 1 from readiness_current where worker_id = w_d) then raise exception 'E17 GAGAL: pekerja tanpa hasil terlewat'; end if;
  if exists (select 1 from worker wk where wk.deleted_at is null and not exists (select 1 from readiness_current rc where rc.worker_id = wk.id)) then
    raise exception 'E17 GAGAL: masih ada pekerja tanpa hasil evaluasi';
  end if;
  checks := checks + 3;

  -- E18 versi baru: aktivasi v2 mengarsipkan v1; perubahan profile mengevaluasi ulang semua pekerja posisi itu
  set local role app_authenticated;
  perform set_config('app.user_id', u_mgr::text, true);
  insert into requirement_profile (organization_id, job_position_id, profile_version) values (org_a, pos, 2) returning id into prof2;
  insert into requirement_profile_item (organization_id, profile_id, item_type, competency_id) values (org_a, prof2, 'COMPETENCY', cmp);
  update requirement_profile set status = 'ACTIVE' where id = prof2;
  reset role;
  if (select status from requirement_profile where id = prof) is distinct from 'ARCHIVED' then raise exception 'E18 GAGAL: v1 tidak diarsipkan'; end if;
  update readiness_outbox set created_at = created_at - interval '1 minute' where status = 'PENDING';
  set local role app_worker;
  perform app.readiness_process(100000);
  reset role;
  select rc.status, rs.profile_version, rs.trigger_type into r from readiness_current rc
    join readiness_snapshot rs on rs.id = rc.snapshot_id where rc.worker_id = w_e;
  if r.status is distinct from 'READY' or r.profile_version is distinct from 2 or r.trigger_type is distinct from 'PROFILE_CHANGE' then
    raise exception 'E18 GAGAL: E setelah v2 %/%/%', r.status, r.profile_version, r.trigger_type;
  end if;
  -- snapshot lama tetap menunjuk v1 (BR-RE-004)
  if not exists (select 1 from readiness_snapshot where worker_id = w_e and profile_version = 1) then
    raise exception 'E18 GAGAL: riwayat snapshot v1 hilang';
  end if;
  checks := checks + 3;

  raise notice 'LULUS: % pemeriksaan readiness engine', checks;
end
$test$;

rollback;

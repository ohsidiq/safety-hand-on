-- notifications.sql: uji migrasi 0008 (SRS-PLT02, DB-007 §4, API-015). Keluaran akhir: NOTICE "LULUS".
-- Prasyarat: migrasi diterapkan dan seed kecil dimuat (minimal 2 organisasi). Semua perubahan dibatalkan.
\set ON_ERROR_STOP on

begin;

do $test$
declare
  org_a uuid; org_b uuid;
  u_adm_a uuid; u_spv_a uuid; u_hseo_a uuid; u_med_a uuid; u_adm_b uuid; u_wrk_a uuid;
  v_ura uuid; v_ev uuid; v_bad uuid; v_n uuid;
  n bigint; rc bigint; r record; checks int := 0;
begin
  select id into org_a from organization order by name limit 1;
  select id into org_b from organization order by name offset 1 limit 1;
  select id into u_adm_a from user_profile where organization_id = org_a and email like 'admin@%';
  select id into u_spv_a from user_profile where organization_id = org_a and email like 'spv1@%';
  select id into u_hseo_a from user_profile where organization_id = org_a and email like 'hseo1@%';
  select id into u_med_a from user_profile where organization_id = org_a and email like 'medis@%';
  select id into u_adm_b from user_profile where organization_id = org_b and email like 'admin@%';
  select id into u_wrk_a from user_profile where organization_id = org_a and email like 'pekerja1@%';

  -- kosongkan antrean dari seed agar hitungan uji jelas
  set local role app_worker;
  perform app.notification_process(100000);
  reset role;

  -- N1 katalog: 24 tipe (DB-007). Aktif: SYSTEM_ALERT (P0) dan tipe P1 yang modulnya sudah ada (M3.6a, 0022);
  -- tipe aktif wajib punya template (FR-PLT02-016). Critical tidak dapat dinonaktifkan
  if (select count(*) from notification_type) <> 24 then raise exception 'N1 GAGAL: katalog bukan 24 tipe'; end if;
  if (select array_agg(code order by code) from notification_type where is_active) <> array['AUTHORIZATION_EXPIRY',
       'COMPETENCY_EXPIRY', 'MEDICAL_EXPIRY', 'SIMPER_EXPIRY', 'SYSTEM_ALERT', 'VERIFICATION_APPROVED', 'VERIFICATION_REJECTED'] then
    raise exception 'N1 GAGAL: tipe aktif tidak sesuai';
  end if;
  if exists (select 1 from notification_type t where t.is_active
             and not exists (select 1 from notification_template x where x.notification_type = t.code)) then
    raise exception 'N1 GAGAL: tipe aktif tanpa template';
  end if;
  if exists (select 1 from notification_type where default_priority = 'CRITICAL' and can_be_disabled) then
    raise exception 'N1 GAGAL: tipe Critical dapat dinonaktifkan';
  end if;
  begin
    update notification_type set can_be_disabled = true where code = 'OBSERVATION_CRITICAL';
    raise exception 'N1 GAGAL: CHECK Critical tidak aktif';
  exception when check_violation then null;
  end;
  checks := checks + 4;

  -- N2 perubahan peran menghasilkan peristiwa SYSTEM_ALERT untuk pengguna yang bersangkutan (outbox, transaksi sama)
  insert into user_role_assignment (user_id, organization_id, role_code, scope_type, granted_by)
  values (u_hseo_a, org_a, 'HSE_MANAGER', 'ORGANIZATION', u_adm_a) returning id into v_ura;
  select id into v_ev from notification_event where entity_id = v_ura and payload->>'change_label' = 'diberikan';
  if v_ev is null or (select recipient_user_ids from notification_event where id = v_ev) <> array[u_hseo_a] then
    raise exception 'N2 GAGAL: peristiwa pemberian peran tidak tercatat untuk penerima yang benar';
  end if;
  update user_role_assignment set revoked_at = now(), revoked_by = u_adm_a where id = v_ura;
  if not exists (select 1 from notification_event where entity_id = v_ura and payload->>'change_label' = 'dicabut') then
    raise exception 'N2 GAGAL: peristiwa pencabutan peran tidak tercatat';
  end if;
  checks := checks + 2;

  -- N3 pemrosesan: notifikasi dibuat dari template, tanpa placeholder tersisa; idempoten (tanpa ganda)
  set local role app_worker;
  perform app.notification_process(100000);
  reset role;
  select * into r from notification where recipient_user_id = u_hseo_a and entity_id = v_ura and body like '%diberikan%';
  if r.id is null then raise exception 'N3 GAGAL: notifikasi pemberian peran tidak dibuat'; end if;
  if r.title <> 'Akses akun Anda berubah' or r.body like '%{%' or r.priority <> 'LOW' or r.link <> '/profile'
     or r.body not like '%HSE Manager%' then
    raise exception 'N3 GAGAL: isi notifikasi tidak sesuai template (% / %)', r.title, r.body;
  end if;
  select count(*) into n from notification where entity_id = v_ura;
  set local role app_worker;
  update notification_event set status = 'PENDING' where id = v_ev;
  perform app.notification_process(100000);
  reset role;
  if (select count(*) from notification where entity_id = v_ura) <> n then raise exception 'N3 GAGAL: pemrosesan ulang menggandakan notifikasi'; end if;
  checks := checks + 3;

  -- N4 tipe tidak aktif: peristiwa selesai tanpa membuat notifikasi
  insert into notification_event (organization_id, notification_type, recipient_user_ids, dedup_key)
  values (org_a, 'READINESS_NOT_READY', array[u_spv_a], 'uji-n4') returning id into v_ev;
  -- N5 penerima nonaktif dan N6 penerima organisasi lain tidak menerima (BR-PLT02-003)
  update user_profile set status = 'DEACTIVATED' where id = u_med_a;
  insert into notification_event (organization_id, notification_type, variant, recipient_user_ids, payload, dedup_key)
  values (org_a, 'SYSTEM_ALERT', 'ACCESS_CHANGED', array[u_med_a, u_adm_b, u_spv_a],
          '{"role_label": "Uji", "change_label": "diberikan"}', 'uji-n56');
  -- N8 peristiwa rusak (varian tanpa template) masuk antrean gagal setelah 5 percobaan
  insert into notification_event (organization_id, notification_type, variant, recipient_user_ids, dedup_key)
  values (org_a, 'SYSTEM_ALERT', 'TIDAK_ADA', array[u_spv_a], 'uji-n8') returning id into v_bad;
  set local role app_worker;
  for i in 1..5 loop perform app.notification_process(100000); end loop;
  reset role;
  if exists (select 1 from notification where dedup_key = 'uji-n4') or (select status from notification_event where id = v_ev) <> 'DONE' then
    raise exception 'N4 GAGAL: tipe tidak aktif menghasilkan notifikasi atau tidak selesai';
  end if;
  if exists (select 1 from notification where dedup_key = 'uji-n56' and recipient_user_id in (u_med_a, u_adm_b)) then
    raise exception 'N5/N6 GAGAL: penerima nonaktif atau organisasi lain menerima notifikasi';
  end if;
  if not exists (select 1 from notification where dedup_key = 'uji-n56' and recipient_user_id = u_spv_a) then
    raise exception 'N5/N6 GAGAL: penerima sah tidak menerima notifikasi';
  end if;
  if not exists (select 1 from notification_event where id = v_bad and status = 'FAILED' and attempts = 5 and last_error like 'TEMPLATE_MISSING%') then
    raise exception 'N8 GAGAL: peristiwa rusak tidak masuk antrean gagal';
  end if;
  update user_profile set status = 'ACTIVE' where id = u_med_a;
  checks := checks + 4;

  -- N7 RLS kotak masuk: hanya milik sendiri; hanya read_at/archived_at yang dapat diubah; tanpa INSERT/DELETE
  select id into v_n from notification where dedup_key = 'uji-n56' and recipient_user_id = u_spv_a;
  set local role app_authenticated;
  perform set_config('app.user_id', u_adm_a::text, true);
  if exists (select 1 from notification where id = v_n) then raise exception 'N7 GAGAL: pengguna lain melihat notifikasi'; end if;
  update notification set read_at = now() where id = v_n;
  get diagnostics rc = row_count;
  if rc <> 0 then raise exception 'N7 GAGAL: pengguna lain dapat menandai notifikasi'; end if;
  perform set_config('app.user_id', u_adm_b::text, true);
  if exists (select 1 from notification where organization_id = org_a) then raise exception 'N7 GAGAL: notifikasi lintas organisasi terlihat'; end if;
  perform set_config('app.user_id', u_spv_a::text, true);
  if not exists (select 1 from notification where id = v_n) then raise exception 'N7 GAGAL: penerima tidak melihat notifikasinya'; end if;
  update notification set read_at = now() where id = v_n;
  get diagnostics rc = row_count;
  if rc <> 1 then raise exception 'N7 GAGAL: penerima tidak dapat menandai dibaca'; end if;
  begin
    update notification set title = 'diubah' where id = v_n;
    raise exception 'N7 GAGAL: judul notifikasi dapat diubah';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from notification where id = v_n;
    raise exception 'N7 GAGAL: notifikasi dapat dihapus';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into notification (organization_id, recipient_user_id, notification_type, priority, title, body, dedup_key)
    values (org_a, u_spv_a, 'SYSTEM_ALERT', 'LOW', 'palsu', 'palsu', 'palsu');
    raise exception 'N7 GAGAL: klien dapat membuat notifikasi (NTF-API-001)';
  exception when insufficient_privilege then null;
  end;
  -- N9 klien tidak dapat menulis antrean peristiwa atau menjalankan pemroses
  begin
    insert into notification_event (organization_id, notification_type, recipient_user_ids, dedup_key)
    values (org_a, 'SYSTEM_ALERT', array[u_spv_a], 'palsu');
    raise exception 'N9 GAGAL: klien dapat menulis notification_event';
  exception when insufficient_privilege then null;
  end;
  begin
    perform app.notification_process(10);
    raise exception 'N9 GAGAL: klien dapat menjalankan notification_process';
  exception when insufficient_privilege then null;
  end;
  -- N10 Worker (scope SELF) membaca notifikasinya sendiri dari pemberian peran saat seed
  perform set_config('app.user_id', u_wrk_a::text, true);
  if not exists (select 1 from notification where body like '%Worker%diberikan%') then
    raise exception 'N10 GAGAL: Worker tidak melihat notifikasinya sendiri';
  end if;
  if exists (select 1 from notification where recipient_user_id <> app.current_user_id()) then
    raise exception 'N10 GAGAL: Worker melihat notifikasi orang lain';
  end if;
  reset role;
  checks := checks + 11;

  raise notice 'LULUS: % pemeriksaan notifikasi', checks;
end
$test$;

rollback;

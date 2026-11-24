-- work_authorization.sql: uji migrasi 0017 (API-006, SRS-WF005 BR-013..017, DB-003 §2.2). Semua perubahan dibatalkan.
\set ON_ERROR_STOP on

begin;

do $test$
declare
  org_a uuid; u_hseo uuid; u_mgr uuid; u_wrk uuid; u_b uuid; site_a1 uuid; site_other uuid;
  w_site1 uuid; w_self uuid; w_other uuid; t_height uuid; wa uuid; wa_w uuid; f_clean uuid; f_other uuid; f_pending uuid;
  n bigint; checks int := 0;
begin
  select id into org_a from organization order by name limit 1;
  select id into u_hseo from user_profile where organization_id = org_a and email like 'hseo1@%';
  select id into u_mgr from user_profile where organization_id = org_a and email like 'hsemgr@%';
  select id into u_wrk from user_profile where organization_id = org_a and email like 'pekerja1@%';
  select id into u_b from user_profile where organization_id = (select id from organization order by name offset 1 limit 1)
    and email like 'admin@%';
  select scope_id into site_a1 from user_role_assignment where user_id = u_hseo and scope_type = 'SITE' and revoked_at is null limit 1;
  select id into w_site1 from worker where site_id = site_a1 and worker_status = 'ACTIVE' and user_id is null order by sho_id limit 1;
  select id into w_self from worker where user_id = u_wrk;
  select id, site_id into w_other, site_other from worker where organization_id = org_a and site_id <> site_a1 limit 1;
  select id into t_height from authorization_type where organization_id = org_a and code = 'AUTH-HEIGHT';

  -- berkas uji (sebagai pemilik tabel)
  insert into file_object (organization_id, bucket, object_path, original_name, mime_type, size_bytes, classification, purpose,
                           uploaded_by, scan_status, scanned_at, checksum_sha256)
  values (org_a, 'soh-files', 'uji/a-clean', 'kt.pdf', 'application/pdf', 100, 'CONFIDENTIAL', 'AUTHORIZATION_DOCUMENT',
          u_hseo, 'CLEAN', now(), repeat('c', 64)) returning id into f_clean;
  insert into file_object (organization_id, bucket, object_path, original_name, mime_type, size_bytes, classification, purpose,
                           uploaded_by, scan_status, scanned_at, checksum_sha256)
  values (org_a, 'soh-files', 'uji/a-other', 'kt2.pdf', 'application/pdf', 100, 'CONFIDENTIAL', 'AUTHORIZATION_DOCUMENT',
          u_mgr, 'CLEAN', now(), repeat('d', 64)) returning id into f_other;
  insert into file_object (organization_id, bucket, object_path, original_name, mime_type, size_bytes, classification, purpose, uploaded_by)
  values (org_a, 'soh-files', 'uji/a-pending', 'kt3.pdf', 'application/pdf', 100, 'CONFIDENTIAL', 'AUTHORIZATION_DOCUMENT', u_hseo)
  returning id into f_pending;

  -- A1 constraint: rentang tanggal, pemisahan tugas, pembekuan tanpa alasan
  begin
    insert into worker_authorization (organization_id, site_id, worker_id, authorization_type_id, valid_from, valid_until, created_by)
    values (org_a, site_a1, w_site1, t_height, '2026-01-01', '2025-12-31', u_hseo);
    raise exception 'A1 GAGAL: valid_until sebelum valid_from diterima';
  exception when check_violation then null;
  end;
  begin
    insert into worker_authorization (organization_id, site_id, worker_id, authorization_type_id, valid_from, created_by,
                                      verification_status, verified_by, verified_at)
    values (org_a, site_a1, w_site1, t_height, '2026-01-01', u_hseo, 'VERIFIED', u_hseo, now());
    raise exception 'A1 GAGAL: pembuat memverifikasi sendiri diterima';
  exception when check_violation then null;
  end;
  begin
    insert into worker_authorization (organization_id, site_id, worker_id, authorization_type_id, valid_from, created_by,
                                      suspension_status, suspended_by, suspended_at, suspension_reason)
    values (org_a, site_a1, w_site1, t_height, '2026-01-01', u_hseo, 'SUSPENDED', u_mgr, now(), ' ');
    raise exception 'A1 GAGAL: pembekuan tanpa alasan diterima';
  exception when check_violation then null;
  end;
  checks := checks + 3;

  -- A2 HSE Officer Site: buat PENDING dengan berkas CLEAN miliknya; bukan berkas orang lain/PENDING; bukan Site lain
  set local role app_authenticated;
  perform set_config('app.user_id', u_hseo::text, true);
  begin
    insert into worker_authorization (organization_id, site_id, worker_id, authorization_type_id, valid_from, file_id, created_by)
    values (org_a, site_a1, w_site1, t_height, current_date - 5, f_pending, u_hseo);
    raise exception 'A2 GAGAL: berkas PENDING diterima';
  exception when check_violation then null;
  end;
  begin
    insert into worker_authorization (organization_id, site_id, worker_id, authorization_type_id, valid_from, file_id, created_by)
    values (org_a, site_a1, w_site1, t_height, current_date - 5, f_other, u_hseo);
    raise exception 'A2 GAGAL: berkas unggahan orang lain diterima';
  exception when check_violation then null;
  end;
  begin
    insert into worker_authorization (organization_id, site_id, worker_id, authorization_type_id, valid_from, created_by)
    values (org_a, site_other, w_other, t_height, current_date, u_hseo);
    raise exception 'A2 GAGAL: Site lain diterima';
  exception when insufficient_privilege then null;
  end;
  insert into worker_authorization (organization_id, site_id, worker_id, authorization_type_id, authorization_number, valid_from,
                                    valid_until, file_id, created_by)
  values (org_a, site_a1, w_site1, t_height, 'KT-UJI-1', current_date - 5, current_date + 700, f_clean, u_hseo) returning id into wa;
  -- HSE Officer tidak dapat memverifikasi atau membekukan
  begin
    update worker_authorization set verification_status = 'VERIFIED', verified_by = u_hseo, verified_at = now() where id = wa;
    raise exception 'A2 GAGAL: HSE Officer memverifikasi';
  exception when check_violation or insufficient_privilege then null;
  end;
  begin
    update worker_authorization set suspension_status = 'SUSPENDED', suspended_by = u_hseo, suspended_at = now(),
           suspension_reason = 'Uji' where id = wa;
    raise exception 'A2 GAGAL: HSE Officer membekukan';
  exception when insufficient_privilege then null;
  end;
  checks := checks + 5;

  -- A3 HSE Manager memverifikasi; berkas terlihat lewat record; perubahan data inti -> PENDING
  perform set_config('app.user_id', u_mgr::text, true);
  if not exists (select 1 from file_object where id = f_clean) then raise exception 'A3 GAGAL: dokumen tidak terlihat pemverifikasi'; end if;
  update worker_authorization set verification_status = 'VERIFIED', verified_by = u_mgr, verified_at = now() where id = wa;
  perform set_config('app.user_id', u_hseo::text, true);
  update worker_authorization set work_scope = 'Perancah di atas 2 meter' where id = wa;
  if (select verification_status from worker_authorization where id = wa) <> 'PENDING' then
    raise exception 'A3 GAGAL: perubahan lingkup tidak mengembalikan ke PENDING';
  end if;
  perform set_config('app.user_id', u_mgr::text, true);
  update worker_authorization set verification_status = 'VERIFIED', verified_by = u_mgr, verified_at = now() where id = wa;
  checks := checks + 3;

  -- A4 pembekuan oleh HSE Manager: NONE -> SUSPENDED -> NONE -> REVOKED; REVOKED akhir; transisi tidak sah ditolak
  begin
    update worker_authorization set suspension_status = 'SUSPENDED', suspended_by = u_hseo, suspended_at = now(),
           suspension_reason = 'Atas nama orang lain' where id = wa;
    raise exception 'A4 GAGAL: pembekuan atas nama orang lain diterima';
  exception when insufficient_privilege then null;
  end;
  update worker_authorization set suspension_status = 'SUSPENDED', suspended_by = u_mgr, suspended_at = now(),
         suspension_reason = 'Investigasi insiden sintetis' where id = wa;
  update worker_authorization set suspension_status = 'NONE', suspended_by = u_mgr, suspension_reason = 'Investigasi selesai' where id = wa;
  if (select suspended_by from worker_authorization where id = wa) is not null then raise exception 'A4 GAGAL: pemulihan tidak mengosongkan pelaku'; end if;
  update worker_authorization set suspension_status = 'REVOKED', suspended_by = u_mgr, suspended_at = now(),
         suspension_reason = 'Pelanggaran berat sintetis' where id = wa;
  begin
    update worker_authorization set suspension_status = 'NONE', suspended_by = u_mgr where id = wa;
    raise exception 'A4 GAGAL: REVOKED dipulihkan';
  exception when check_violation then null;
  end;
  begin
    update worker_authorization set valid_until = current_date + 10 where id = wa;
    raise exception 'A4 GAGAL: record REVOKED diubah';
  exception when check_violation then null;
  end;
  checks := checks + 4;

  -- A5 pekerja (SELF): mengajukan miliknya, tidak milik orang lain, tidak membekukan; tenant lain tidak melihat
  perform set_config('app.user_id', u_wrk::text, true);
  insert into worker_authorization (organization_id, site_id, worker_id, authorization_type_id, valid_from, created_by)
  select org_a, w.site_id, w.id, t_height, current_date - 1, u_wrk from worker w where w.id = w_self returning id into wa_w;
  if wa_w is null then raise exception 'A5 GAGAL: pekerja tidak dapat mengajukan otorisasinya'; end if;
  if exists (select 1 from worker_authorization where worker_id <> w_self) then raise exception 'A5 GAGAL: pekerja melihat milik orang lain'; end if;
  begin
    update worker_authorization set suspension_status = 'SUSPENDED', suspended_by = u_wrk, suspended_at = now(),
           suspension_reason = 'x' where id = wa_w;
    raise exception 'A5 GAGAL: pekerja membekukan';
  exception when insufficient_privilege then null;
  end;
  perform set_config('app.user_id', u_b::text, true);
  if exists (select 1 from worker_authorization where id in (wa, wa_w)) or exists (select 1 from file_object where id = f_clean) then
    raise exception 'A5 GAGAL: tenant lain melihat otorisasi atau dokumen';
  end if;
  checks := checks + 4;
  reset role;

  -- A6 audit
  select count(distinct payload->>'action') into n from audit_outbox where payload->>'entity_id' = wa::text
     and payload->>'action' in ('authorization.create', 'authorization.verify', 'authorization.resubmit', 'authorization.suspend',
                                'authorization.reinstate', 'authorization.revoke');
  if n <> 6 then raise exception 'A6 GAGAL: audit otorisasi tidak lengkap (% dari 6)', n; end if;
  checks := checks + 1;

  raise notice 'LULUS: % pemeriksaan Otorisasi Kerja', checks;
end
$test$;

rollback;

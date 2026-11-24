-- competency.sql: uji migrasi 0016 (DB-003 §2.1/§3, SRS-WF003 BR-011/012/013, PB-009). Semua perubahan dibatalkan.
\set ON_ERROR_STOP on

begin;

do $test$
declare
  org_a uuid; org_b uuid; u_hseo uuid; u_mgr uuid; u_adm uuid; u_spv uuid; u_wrk uuid; u_b uuid;
  site_a1 uuid; site_other uuid; w_site1 uuid; w_self uuid; w_other_site uuid; cmp uuid; wc uuid; wc2 uuid; f_clean uuid; f_pending uuid;
  n bigint; checks int := 0;
begin
  select id into org_a from organization order by name limit 1;
  select id into org_b from organization order by name offset 1 limit 1;
  select id into u_hseo from user_profile where organization_id = org_a and email like 'hseo1@%';
  select id into u_mgr from user_profile where organization_id = org_a and email like 'hsemgr@%';
  select id into u_adm from user_profile where organization_id = org_a and email like 'admin@%';
  select id into u_spv from user_profile where organization_id = org_a and email like 'spv1@%';
  select id into u_wrk from user_profile where organization_id = org_a and email like 'pekerja1@%';
  select id into u_b from user_profile where organization_id = org_b and email like 'admin@%';
  select scope_id into site_a1 from user_role_assignment where user_id = u_hseo and scope_type = 'SITE' and revoked_at is null limit 1;
  select id into w_site1 from worker where site_id = site_a1 and worker_status = 'ACTIVE' and user_id is null limit 1;
  select id into w_self from worker where user_id = u_wrk;
  select id, site_id into w_other_site, site_other from worker where organization_id = org_a and site_id <> site_a1 limit 1;
  select id into cmp from competency where organization_id = org_a and code = 'CMP-OPR-AB';

  -- K1 constraint DB-003 §2.1 (sebagai pemilik tabel, tanpa RLS)
  begin
    insert into worker_competency (organization_id, site_id, worker_id, competency_id, valid_from, valid_until, created_by)
    values (org_a, site_a1, w_site1, cmp, '2026-01-01', '2025-01-01', u_hseo);
    raise exception 'K1 GAGAL: valid_until sebelum valid_from diterima';
  exception when check_violation then null;
  end;
  begin
    insert into worker_competency (organization_id, site_id, worker_id, competency_id, valid_from, created_by,
                                   verification_status, verified_by, verified_at)
    values (org_a, site_a1, w_site1, cmp, '2026-01-01', u_hseo, 'VERIFIED', u_hseo, now());
    raise exception 'K1 GAGAL: pembuat memverifikasi record sendiri diterima';
  exception when check_violation then null;
  end;
  begin
    insert into worker_competency (organization_id, site_id, worker_id, competency_id, valid_from, created_by,
                                   verification_status, verified_by, rejection_reason)
    values (org_a, site_a1, w_site1, cmp, '2026-01-01', u_hseo, 'REJECTED', u_mgr, '   ');
    raise exception 'K1 GAGAL: penolakan tanpa alasan diterima';
  exception when check_violation then null;
  end;
  begin
    insert into worker_competency (organization_id, site_id, worker_id, competency_id, valid_from, created_by)
    values (org_a, site_a1, w_other_site, cmp, '2026-01-01', u_hseo);
    raise exception 'K1 GAGAL: Site record berbeda dengan Site pekerja diterima';
  exception when foreign_key_violation then null;
  end;
  checks := checks + 4;

  insert into worker_competency (organization_id, site_id, worker_id, competency_id, valid_from, created_by)
  values (org_a, site_a1, w_site1, (select id from competency where organization_id = org_a and code = 'CMP-LAS'), current_date - 5, u_mgr)
  returning id into wc2;

  -- K2 HSE Officer Site membuat record PENDING di Site-nya; tidak di Site lain; tidak langsung VERIFIED
  set local role app_authenticated;
  perform set_config('app.user_id', u_hseo::text, true);
  insert into worker_competency (organization_id, site_id, worker_id, competency_id, valid_from, valid_until, created_by)
  values (org_a, site_a1, w_site1, cmp, current_date - 10, current_date + 700, u_hseo) returning id into wc;
  begin
    insert into worker_competency (organization_id, site_id, worker_id, competency_id, valid_from, created_by)
    values (org_a, site_other, w_other_site, cmp, current_date, u_hseo);
    raise exception 'K2 GAGAL: kompetensi di Site lain diterima';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into worker_competency (organization_id, site_id, worker_id, competency_id, valid_from, created_by,
                                   verification_status, verified_by, verified_at)
    values (org_a, site_a1, w_site1, cmp, current_date, u_hseo, 'VERIFIED', u_mgr, now());
    raise exception 'K2 GAGAL: record langsung VERIFIED diterima';
  exception when insufficient_privilege then null;
  end;
  -- HSE Officer tidak dapat memverifikasi (permission LIMITED) dan tidak dapat mengatasnamakan pemverifikasi
  begin
    update worker_competency set verification_status = 'VERIFIED', verified_by = u_mgr, verified_at = now() where id = wc;
    raise exception 'K2 GAGAL: verifikasi atas nama orang lain diterima';
  exception when insufficient_privilege then null;
  end;
  -- record buatan orang lain pun tidak boleh diverifikasi HSE Officer (tanpa competency.verify efektif)
  begin
    update worker_competency set verification_status = 'VERIFIED', verified_by = u_hseo, verified_at = now() where id = wc2;
    raise exception 'K2 GAGAL: HSE Officer memverifikasi tanpa competency.verify';
  exception when insufficient_privilege then null;
  end;
  checks := checks + 4;
  raise notice 'LULUS: % pemeriksaan kompetensi (blok 1)', checks;
end
$test$;

-- K3..K7 dalam blok terpisah agar penanganan galat K2 tidak menelan galat berikutnya
do $test$
declare
  org_a uuid; u_hseo uuid; u_mgr uuid; u_spv uuid; u_wrk uuid; u_b uuid; site_a1 uuid; w_site1 uuid; w_self uuid;
  wc uuid; wc_w uuid; f_clean uuid; f_pending uuid; v int; n bigint; checks int := 0;
begin
  reset role;
  select id into org_a from organization order by name limit 1;
  select id into u_hseo from user_profile where organization_id = org_a and email like 'hseo1@%';
  select id into u_mgr from user_profile where organization_id = org_a and email like 'hsemgr@%';
  select id into u_spv from user_profile where organization_id = org_a and email like 'spv1@%';
  select id into u_wrk from user_profile where organization_id = org_a and email like 'pekerja1@%';
  select id into u_b from user_profile where organization_id = (select id from organization order by name offset 1 limit 1) and email like 'admin@%';
  select scope_id into site_a1 from user_role_assignment where user_id = u_hseo and scope_type = 'SITE' and revoked_at is null limit 1;
  select id into w_self from worker where user_id = u_wrk;
  select id into wc from worker_competency where created_by = u_hseo and verification_status = 'PENDING'
    and competency_id = (select id from competency where organization_id = org_a and code = 'CMP-OPR-AB') order by created_at desc limit 1;

  -- K3 HSE Manager memverifikasi (pemisahan tugas terpenuhi); transisi hanya dari PENDING
  set local role app_authenticated;
  perform set_config('app.user_id', u_mgr::text, true);
  update worker_competency set verification_status = 'VERIFIED', verified_by = u_mgr, verified_at = now(),
         verification_comment = 'Sertifikat sintetis sesuai' where id = wc;
  if (select verification_status from worker_competency where id = wc) <> 'VERIFIED' then raise exception 'K3 GAGAL: verifikasi tidak tersimpan'; end if;
  begin
    update worker_competency set verification_status = 'REJECTED', verified_by = u_mgr, rejection_reason = 'Ubah' where id = wc;
    raise exception 'K3 GAGAL: VERIFIED langsung menjadi REJECTED';
  exception when check_violation then null;
  end;
  checks := checks + 2;

  -- K4 data inti berubah pada record VERIFIED -> PENDING, verifikator dikosongkan (BR-WF003-012)
  perform set_config('app.user_id', u_hseo::text, true);
  select version into v from worker_competency where id = wc;
  update worker_competency set valid_until = valid_until + 30 where id = wc;
  if (select verification_status from worker_competency where id = wc) <> 'PENDING'
     or (select verified_by from worker_competency where id = wc) is not null then
    raise exception 'K4 GAGAL: perubahan data inti tidak mengembalikan ke PENDING';
  end if;
  if (select version from worker_competency where id = wc) <> v + 1 then raise exception 'K4 GAGAL: version tidak naik'; end if;
  checks := checks + 2;

  -- K5 sertifikat: berkas wajib CLEAN dan bertujuan sertifikat; sertifikat baru pada VERIFIED -> PENDING
  reset role;
  insert into file_object (organization_id, bucket, object_path, original_name, mime_type, size_bytes, classification, purpose,
                           uploaded_by, scan_status, scanned_at, checksum_sha256)
  values (org_a, 'soh-files', 'uji/k5-clean', 'cert.pdf', 'application/pdf', 100, 'CONFIDENTIAL', 'COMPETENCY_CERTIFICATE',
          u_hseo, 'CLEAN', now(), repeat('b', 64)) returning id into f_clean;
  insert into file_object (organization_id, bucket, object_path, original_name, mime_type, size_bytes, classification, purpose, uploaded_by)
  values (org_a, 'soh-files', 'uji/k5-pending', 'cert2.pdf', 'application/pdf', 100, 'CONFIDENTIAL', 'COMPETENCY_CERTIFICATE', u_hseo)
  returning id into f_pending;
  update worker_competency set verification_status = 'VERIFIED', verified_by = u_mgr, verified_at = now() where id = wc;
  set local role app_authenticated;
  perform set_config('app.user_id', u_hseo::text, true);
  begin
    insert into competency_certificate (organization_id, worker_competency_id, issue_date, file_id, created_by)
    values (org_a, wc, current_date - 10, f_pending, u_hseo);
    raise exception 'K5 GAGAL: berkas PENDING diterima sebagai sertifikat';
  exception when check_violation then null;
  end;
  insert into competency_certificate (organization_id, worker_competency_id, certificate_number, issue_date, expiry_date, file_id, created_by)
  values (org_a, wc, 'CERT-SINTETIS-1', current_date - 10, current_date + 700, f_clean, u_hseo);
  if (select verification_status from worker_competency where id = wc) <> 'PENDING' then
    raise exception 'K5 GAGAL: sertifikat baru tidak mengembalikan ke PENDING';
  end if;
  checks := checks + 2;

  -- K6 berkas sertifikat terlihat lewat record pemilik: HSE Manager (bukan pengunggah) melihat, Supervisor Site lain/tenant lain tidak
  perform set_config('app.user_id', u_mgr::text, true);
  if not exists (select 1 from file_object where id = f_clean) then raise exception 'K6 GAGAL: berkas sertifikat tidak terlihat pemverifikasi'; end if;
  if exists (select 1 from file_object where id = f_pending) then raise exception 'K6 GAGAL: berkas tanpa record terlihat orang lain'; end if;
  perform set_config('app.user_id', u_b::text, true);
  if exists (select 1 from worker_competency where id = wc) or exists (select 1 from file_object where id = f_clean) then
    raise exception 'K6 GAGAL: tenant lain melihat kompetensi atau berkas';
  end if;
  checks := checks + 3;

  -- K7 Supervisor Site hanya Site-nya; pekerja hanya kompetensinya sendiri dan tidak dapat mengubah
  perform set_config('app.user_id', u_spv::text, true);
  if exists (select 1 from worker_competency where site_id <> site_a1) then raise exception 'K7 GAGAL: Supervisor melihat Site lain'; end if;
  perform set_config('app.user_id', u_wrk::text, true);
  if exists (select 1 from worker_competency where worker_id <> w_self) then raise exception 'K7 GAGAL: pekerja melihat kompetensi orang lain'; end if;
  -- WORKER competency.update SELF: boleh mencatat untuk dirinya (PENDING), tidak untuk orang lain, tidak memverifikasi
  insert into worker_competency (organization_id, site_id, worker_id, competency_id, valid_from, created_by)
  select org_a, w.site_id, w.id, (select id from competency where organization_id = org_a and code = 'CMP-LAS'), current_date - 1, u_wrk
    from worker w where w.id = w_self returning id into wc_w;
  if wc_w is null then raise exception 'K7 GAGAL: pekerja tidak dapat mencatat kompetensinya sendiri'; end if;
  begin
    insert into worker_competency (organization_id, site_id, worker_id, competency_id, valid_from, created_by)
    values (org_a, site_a1, (select id from worker where site_id = site_a1 and id <> w_self limit 1),
            (select id from competency where organization_id = org_a and code = 'CMP-LAS'), current_date, u_wrk);
    raise exception 'K7 GAGAL: pekerja mencatat kompetensi orang lain';
  exception when insufficient_privilege then null;
  end;
  begin
    update worker_competency set verification_status = 'VERIFIED', verified_by = u_wrk, verified_at = now()
     where worker_id = w_self and created_by <> u_wrk;
    get diagnostics n = row_count;
    if n > 0 then raise exception 'K7 GAGAL: pekerja memverifikasi kompetensinya'; end if;
  exception when insufficient_privilege then null;
  end;
  checks := checks + 4;
  reset role;

  -- K8 audit: buat, verifikasi, ubah, sertifikat, kembali PENDING
  if (select count(distinct payload->>'action') from audit_outbox where payload->>'entity_id' = wc::text
      and payload->>'action' in ('competency.create', 'competency.verify', 'competency.resubmit', 'competency.certificate_add')) <> 4 then
    raise exception 'K8 GAGAL: audit kompetensi tidak lengkap';
  end if;
  checks := checks + 1;

  raise notice 'LULUS: % pemeriksaan kompetensi (blok 2)', checks;
end
$test$;

rollback;

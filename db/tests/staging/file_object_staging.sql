-- file_object_staging.sql: uji migrasi 0015 untuk Supabase SQL Editor. Diakhiri exception: semua perubahan dibatalkan.




do $test$
declare
  org_a uuid; org_b uuid; u_hseo uuid; u_adm uuid; u_b uuid; f uuid; n bigint; checks int := 0;
begin
  select id into org_a from organization order by name limit 1;
  select id into org_b from organization order by name offset 1 limit 1;
  select id into u_hseo from user_profile where organization_id = org_a and email like 'hseo1@%';
  select id into u_adm from user_profile where organization_id = org_a and email like 'admin@%';
  select id into u_b from user_profile where organization_id = org_b and email like 'admin@%';

  -- F1 dokumen medis wajib bucket medis dan Sensitif; jenis di luar daftar putih dan PDF > 10 MB ditolak
  begin
    insert into file_object (organization_id, bucket, object_path, original_name, mime_type, size_bytes, classification, purpose, uploaded_by)
    values (org_a, 'soh-files', 'x/1', 'mcu.pdf', 'application/pdf', 10, 'SENSITIVE', 'MEDICAL_DOCUMENT', u_hseo);
    raise exception 'F1 GAGAL: dokumen medis di bucket umum diterima';
  exception when check_violation then null;
  end;
  begin
    insert into file_object (organization_id, bucket, object_path, original_name, mime_type, size_bytes, classification, purpose, uploaded_by)
    values (org_a, 'soh-medical', 'x/2', 'mcu.pdf', 'application/pdf', 10, 'CONFIDENTIAL', 'MEDICAL_DOCUMENT', u_hseo);
    raise exception 'F1 GAGAL: dokumen medis bukan Sensitif diterima';
  exception when check_violation then null;
  end;
  begin
    insert into file_object (organization_id, bucket, object_path, original_name, mime_type, size_bytes, classification, purpose, uploaded_by)
    values (org_a, 'soh-files', 'x/3', 'a.exe', 'application/x-msdownload', 10, 'CONFIDENTIAL', 'COMPETENCY_CERTIFICATE', u_hseo);
    raise exception 'F1 GAGAL: jenis di luar daftar putih diterima';
  exception when check_violation then null;
  end;
  begin
    insert into file_object (organization_id, bucket, object_path, original_name, mime_type, size_bytes, classification, purpose, uploaded_by)
    values (org_a, 'soh-files', 'x/4', 'a.pdf', 'application/pdf', 11000000, 'CONFIDENTIAL', 'COMPETENCY_CERTIFICATE', u_hseo);
    raise exception 'F1 GAGAL: PDF di atas 10 MB diterima';
  exception when check_violation then null;
  end;
  checks := checks + 4;

  -- F2 aplikasi: pengunggah sendiri, organisasi sendiri, mulai PENDING
  set local role app_authenticated;
  perform set_config('app.user_id', u_hseo::text, true);
  begin
    insert into file_object (organization_id, bucket, object_path, original_name, mime_type, size_bytes, classification, purpose, uploaded_by)
    values (org_a, 'soh-files', 'x/5', 'a.pdf', 'application/pdf', 10, 'CONFIDENTIAL', 'COMPETENCY_CERTIFICATE', u_adm);
    raise exception 'F2 GAGAL: unggah atas nama orang lain diterima';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into file_object (organization_id, bucket, object_path, original_name, mime_type, size_bytes, classification, purpose, uploaded_by, scan_status, scanned_at)
    values (org_a, 'soh-files', 'x/6', 'a.pdf', 'application/pdf', 10, 'CONFIDENTIAL', 'COMPETENCY_CERTIFICATE', u_hseo, 'CLEAN', now());
    raise exception 'F2 GAGAL: berkas langsung CLEAN diterima';
  exception when insufficient_privilege then null;
  end;
  insert into file_object (organization_id, bucket, object_path, original_name, mime_type, size_bytes, classification, purpose, uploaded_by)
  values (org_a, 'soh-files', 'x/7', 'a.pdf', 'application/pdf', 10, 'CONFIDENTIAL', 'COMPETENCY_CERTIFICATE', u_hseo) returning id into f;
  checks := checks + 3;

  -- F3 orang lain (termasuk Company Admin dan tenant lain) tidak melihat berkas
  perform set_config('app.user_id', u_adm::text, true);
  if exists (select 1 from file_object where id = f) then raise exception 'F3 GAGAL: berkas terlihat pengguna lain'; end if;
  perform set_config('app.user_id', u_b::text, true);
  if exists (select 1 from file_object where id = f) then raise exception 'F3 GAGAL: berkas terlihat tenant lain'; end if;
  checks := checks + 2;

  -- F4 hasil pemeriksaan sekali saja; kolom lain tidak dapat diubah
  perform set_config('app.user_id', u_hseo::text, true);
  update file_object set scan_status = 'CLEAN', scanned_at = now(), checksum_sha256 = repeat('a', 64) where id = f;
  update file_object set scan_status = 'FAILED' where id = f;
  get diagnostics n = row_count;
  if n <> 0 or (select scan_status from file_object where id = f) <> 'CLEAN' then raise exception 'F4 GAGAL: hasil pemeriksaan dapat diubah'; end if;
  begin
    update file_object set bucket = 'soh-medical' where id = f;
    raise exception 'F4 GAGAL: bucket dapat diubah aplikasi';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from file_object where id = f;
    raise exception 'F4 GAGAL: metadata dapat dihapus aplikasi';
  exception when insufficient_privilege then null;
  end;
  reset role;
  checks := checks + 3;

  -- F5 audit unggah dan pemeriksaan tanpa nama berkas asli
  if (select count(*) from audit_outbox where payload->>'entity_id' = f::text and payload->>'action' in ('file.upload', 'file.scan')) <> 2 then
    raise exception 'F5 GAGAL: audit berkas tidak lengkap';
  end if;
  if exists (select 1 from audit_outbox where payload->>'entity_id' = f::text and payload::text like '%a.pdf%') then
    raise exception 'F5 GAGAL: nama berkas masuk audit';
  end if;
  checks := checks + 2;

  raise exception 'HASIL_UJI LULUS: % pemeriksaan file privat (perubahan uji dibatalkan)', checks;
end
$test$;

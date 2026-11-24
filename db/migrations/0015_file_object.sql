-- 0015: Metadata file privat (M3.1)
-- Sumber: DB-008 §3.1-§3.2 (file_object, bucket privat, daftar putih, batas ukuran, pemindaian), API-000 §14.
-- Berkas disimpan di Supabase Storage bucket privat; database hanya menyimpan metadata. Tabel lain merujuk file_id.
-- Keputusan P0 (Lanjutan 67): pemeriksaan isi (tanda tangan berkas, ukuran, SHA-256) menggantikan antivirus sampai
-- ada pemindai yang aman untuk data Sensitif; antivirus wajib sebelum data nyata (B-24).
-- Data sintetis saja (B-24).

create table file_object (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organization (id),
  bucket           text not null check (bucket in ('soh-files', 'soh-medical')),
  object_path      text not null unique,
  original_name    text not null check (length(original_name) between 1 and 200),
  mime_type        text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  size_bytes       bigint not null check (size_bytes > 0 and size_bytes <= 20971520),
  checksum_sha256  text check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  classification   text not null check (classification in ('INTERNAL', 'CONFIDENTIAL', 'SENSITIVE')),
  -- tujuan menentukan bucket, permission unggah, dan siapa yang boleh mengunduh lewat record pemilik
  purpose          text not null check (purpose in ('COMPETENCY_CERTIFICATE', 'AUTHORIZATION_DOCUMENT', 'SIMPER_DOCUMENT',
                                                    'MEDICAL_DOCUMENT')),
  scan_status      text not null default 'PENDING' check (scan_status in ('PENDING', 'CLEAN', 'INFECTED', 'FAILED')),
  scan_detail      text check (scan_detail in ('MISSING_OBJECT', 'SIZE_MISMATCH', 'TYPE_MISMATCH', 'TOO_LARGE')),
  scanned_at       timestamptz,
  uploaded_by      uuid not null references user_profile (id),
  uploaded_at      timestamptz not null default now(),
  deleted_at       timestamptz,
  constraint file_object_org_uq unique (id, organization_id),
  -- dokumen medis selalu Sensitif dan di bucket medis terpisah (DB-008 §3.2)
  constraint file_object_medical_chk check ((purpose = 'MEDICAL_DOCUMENT') = (bucket = 'soh-medical')
                                            and (purpose <> 'MEDICAL_DOCUMENT' or classification = 'SENSITIVE')),
  constraint file_object_pdf_size_chk check (mime_type <> 'application/pdf' or size_bytes <= 10485760),
  constraint file_object_scan_chk check ((scan_status = 'PENDING') = (scanned_at is null))
);
create index file_object_org_uploader_idx on file_object (organization_id, uploaded_by, uploaded_at desc);

alter table file_object enable row level security;
alter table file_object force row level security;
revoke all on file_object from public;
grant select, insert on file_object to app_authenticated;
grant update (scan_status, scan_detail, scanned_at, checksum_sha256) on file_object to app_authenticated;

-- M3.1: pengunggah melihat berkasnya sendiri. Akses lewat record pemilik (sertifikat, MCU, dll.) ditambahkan per modul.
create policy file_object_read on file_object for select to app_authenticated
  using (organization_id = (select app.current_org()) and uploaded_by = (select app.current_user_id()) and deleted_at is null);
create policy file_object_insert on file_object for insert to app_authenticated
  with check (organization_id = (select app.current_org()) and uploaded_by = (select app.current_user_id())
              and scan_status = 'PENDING');
-- hasil pemeriksaan hanya sekali: PENDING -> CLEAN/FAILED/INFECTED
create policy file_object_scan on file_object for update to app_authenticated
  using (organization_id = (select app.current_org()) and uploaded_by = (select app.current_user_id())
         and scan_status = 'PENDING' and deleted_at is null)
  with check (scan_status <> 'PENDING');

-- pencatatan audit unggahan (tanpa nama berkas asli: dapat memuat data pribadi)
create function app.audit_file_object() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    perform app.audit_enqueue(new.organization_id, 'file.upload', 'file_object', new.id,
      array['purpose', 'mime_type', 'size_bytes', 'classification'],
      jsonb_build_object('purpose', new.purpose, 'mime_type', new.mime_type, 'size_bytes', new.size_bytes,
                         'classification', new.classification),
      null, null, 'SUCCESS', new.classification = 'SENSITIVE');
  elsif new.scan_status is distinct from old.scan_status then
    perform app.audit_enqueue(new.organization_id, 'file.scan', 'file_object', new.id,
      array['scan_status', 'scan_detail'],
      jsonb_build_object('scan_status', jsonb_build_object('from', old.scan_status, 'to', new.scan_status),
                         'scan_detail', new.scan_detail),
      null, null, case when new.scan_status = 'CLEAN' then 'SUCCESS' else 'FAILED' end, new.classification = 'SENSITIVE');
  end if;
  return null;
end $$;
revoke execute on function app.audit_file_object() from public;
create trigger audit_file_object after insert or update on file_object
  for each row execute function app.audit_file_object();

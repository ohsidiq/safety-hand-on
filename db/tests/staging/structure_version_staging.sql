-- structure_version_staging.sql: uji migrasi 0011 untuk Supabase SQL Editor.
-- Diakhiri exception agar SEMUA perubahan uji dibatalkan. Hasil yang diharapkan:
--   ERROR: HASIL_UJI LULUS: N pemeriksaan versi struktur (perubahan uji dibatalkan)

do $test$
declare
  org_a uuid; site_a1 uuid; site_a2 uuid; team_a1 uuid; dep_a1 uuid; pos uuid; w_other uuid;
  v1 int; v2 int; t1 timestamptz; n bigint; checks int := 0;
begin
  select id into org_a from organization order by name limit 1;
  select id into site_a1 from site where organization_id = org_a and code = 'SITE-1';
  select id into site_a2 from site where organization_id = org_a and code = 'SITE-2';
  select id into team_a1 from team where site_id = site_a1 and code = 'TIM-PROD';
  select id into dep_a1 from department where site_id = site_a1 and code = 'PROD';
  select id into pos from job_position where organization_id = org_a and status = 'ACTIVE' order by code limit 1;
  select id into w_other from worker where organization_id = org_a and site_id = site_a2 limit 1;

  -- V1 setiap tabel struktur punya version (mulai 1) dan updated_at
  select count(*) into n from information_schema.columns
  where table_schema = 'public' and column_name in ('version', 'updated_at')
    and table_name in ('organization', 'site', 'department', 'division', 'team', 'job_position', 'equipment_class');
  if n <> 14 then raise exception 'V1 GAGAL: kolom version/updated_at tidak lengkap (%)', n; end if;
  if exists (select 1 from site where version < 1) then raise exception 'V1 GAGAL: version tidak sah'; end if;
  checks := checks + 2;

  -- V2 perubahan nyata menaikkan version satu; pembaruan tanpa perubahan tidak menaikkan
  select version, updated_at into v1, t1 from department where id = dep_a1;
  update department set name = name || ' X' where id = dep_a1;
  select version into v2 from department where id = dep_a1;
  if v2 <> v1 + 1 then raise exception 'V2 GAGAL: version tidak naik (% -> %)', v1, v2; end if;
  update department set name = name where id = dep_a1;
  if (select version from department where id = dep_a1) <> v2 then raise exception 'V2 GAGAL: pembaruan kosong menaikkan version'; end if;
  select version into v1 from job_position where id = pos;
  update job_position set description = coalesce(description, '') || ' uji' where id = pos;
  if (select version from job_position where id = pos) <> v1 + 1 then raise exception 'V2 GAGAL: version job_position tidak naik'; end if;
  select version into v1 from organization where id = org_a;
  update organization set name = name || ' X' where id = org_a;
  if (select version from organization where id = org_a) <> v1 + 1 then raise exception 'V2 GAGAL: version organization tidak naik'; end if;
  -- version tidak dapat dipaksa klien: nilai yang dikirim diabaikan
  select version into v1 from site where id = site_a1;
  update site set version = 99, location = coalesce(location, '') || ' Uji' where id = site_a1;
  if (select version from site where id = site_a1) <> v1 + 1 then raise exception 'V2 GAGAL: version dapat disetel bebas'; end if;
  checks := checks + 4;

  -- V3 audit tidak memuat version/updated_at sebagai field yang berubah
  if exists (select 1 from audit_outbox where payload->>'entity_id' = dep_a1::text
             and (payload->'changed_fields' ? 'version' or payload->'changed_fields' ? 'updated_at')) then
    raise exception 'V3 GAGAL: version/updated_at tercatat di audit';
  end if;
  if not exists (select 1 from audit_outbox where payload->>'entity_id' = dep_a1::text and payload->>'action' = 'department.update'
                 and payload->'changed_fields' ? 'name') then
    raise exception 'V3 GAGAL: perubahan nama department tidak tercatat';
  end if;
  checks := checks + 2;

  -- V4 anggota team harus ditempatkan di Site team (PB-008 scope Tim tidak menjangkau Site lain)
  begin
    insert into team_member (organization_id, team_id, worker_id, valid_from) values (org_a, team_a1, w_other, current_date);
    raise exception 'V4 GAGAL: pekerja Site lain diterima sebagai anggota team';
  exception when check_violation then null;
  end;
  checks := checks + 1;

  raise exception 'HASIL_UJI LULUS: % pemeriksaan versi struktur (perubahan uji dibatalkan)', checks;
end
$test$;

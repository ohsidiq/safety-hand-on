-- medical_master_delete_staging.sql: uji migrasi 0021 (B-28) untuk Supabase SQL Editor. Data sintetis. Diakhiri exception:
-- semua perubahan dibatalkan.

do $test$
declare
  org_a uuid; org_b uuid; u_mgr uuid; u_doc uuid; u_hseo uuid; u_b uuid;
  t_unused uuid; t_used uuid; c_unused uuid; c_used uuid; n bigint; checks int := 0;
begin
  select id into org_a from organization order by name limit 1;
  select id into org_b from organization order by name offset 1 limit 1;
  select id into u_mgr from user_profile where organization_id = org_a and email like 'hsemgr@%';
  select id into u_doc from user_profile where organization_id = org_a and email like 'dokter@%';
  select id into u_hseo from user_profile where organization_id = org_a and email like 'hseo1@%';
  select id into u_b from user_profile where organization_id = org_b and email like 'hsemgr@%';
  insert into medical_exam_type (organization_id, name, code) values (org_a, 'Uji Hapus', 'UJI-HAPUS') returning id into t_unused;
  select exam_type_id into t_used from medical_record where organization_id = org_a limit 1;
  insert into medical_clearance_type (organization_id, name, code) values (org_a, 'Uji Hapus', 'UJI-HAPUS') returning id into c_unused;
  select clearance_type_id into c_used from medical_clearance where organization_id = org_a limit 1;
  if t_used is null or c_used is null then raise exception 'SETUP GAGAL: master terpakai tidak ditemukan'; end if;

  set local role app_authenticated;
  -- X1 hanya pengelola master (readiness_profile.manage) yang dapat menghapus; Dokter dan HSE Officer tidak
  foreach n in array array[1, 2] loop
    perform set_config('app.user_id', (case n when 1 then u_doc else u_hseo end)::text, true);
    delete from medical_exam_type where id = t_unused;
    delete from medical_clearance_type where id = c_unused;
  end loop;
  if not exists (select 1 from medical_exam_type where id = t_unused) or not exists (select 1 from medical_clearance_type where id = c_unused) then
    raise exception 'X1 GAGAL: peran tanpa readiness_profile.manage menghapus master';
  end if;
  checks := checks + 1;

  -- X2 tenant lain tidak dapat menghapus
  perform set_config('app.user_id', u_b::text, true);
  delete from medical_exam_type where id = t_unused;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'X2 GAGAL: tenant lain menghapus master'; end if;
  checks := checks + 1;

  -- X3 master terpakai ditolak kunci asing (riwayat utuh)
  perform set_config('app.user_id', u_mgr::text, true);
  begin
    delete from medical_exam_type where id = t_used;
    raise exception 'X3 GAGAL: jenis pemeriksaan terpakai terhapus';
  exception when foreign_key_violation then null;
  end;
  begin
    delete from medical_clearance_type where id = c_used;
    raise exception 'X3 GAGAL: jenis kerja khusus terpakai terhapus';
  exception when foreign_key_violation then null;
  end;
  checks := checks + 2;

  -- X4 master belum dipakai terhapus oleh HSE Manager
  delete from medical_exam_type where id = t_unused;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'X4 GAGAL: jenis pemeriksaan belum dipakai tidak terhapus'; end if;
  delete from medical_clearance_type where id = c_unused;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'X4 GAGAL: jenis kerja khusus belum dipakai tidak terhapus'; end if;
  checks := checks + 2;
  reset role;

  -- X5 audit penghapusan dengan pelaku
  select count(*) into n from audit_outbox
   where payload->>'entity_id' in (t_unused::text, c_unused::text)
     and payload->>'action' in ('medical_exam_type.delete', 'medical_clearance_type.delete')
     and payload->>'actor_user_id' = u_mgr::text;
  if n <> 2 then raise exception 'X5 GAGAL: audit penghapusan (% dari 2)', n; end if;
  checks := checks + 1;

  raise exception 'HASIL_UJI LULUS: % pemeriksaan hapus master Medical (perubahan uji dibatalkan)', checks;
end
$test$;

-- worker.sql: uji migrasi 0010 (DB-001 §8-§10, API-003 §2-§4, PB-008 scope Tim). Keluaran akhir: NOTICE "LULUS".
-- Prasyarat: migrasi diterapkan dan seed kecil dimuat (minimal 2 organisasi, 3 Site). Semua perubahan dibatalkan.
\set ON_ERROR_STOP on

begin;

do $test$
declare
  org_a uuid; org_b uuid; site_a1 uuid; site_a2 uuid;
  dep_a1_prod uuid; dep_a1_maint uuid; dep_a2_prod uuid; team_a1 uuid; pos_helper uuid; ctr_a uuid;
  u_adm_a uuid; u_spvtim uuid; u_spv_a uuid; u_wrk_a uuid;
  w_new uuid; w_ctr uuid; w_team uuid; w_notteam uuid; w_linked uuid;
  v_sho text; n bigint; rc bigint; r record; v_members uuid[]; checks int := 0;
begin
  select id into org_a from organization order by name limit 1;
  select id into org_b from organization order by name offset 1 limit 1;
  select id into site_a1 from site where organization_id = org_a and code = 'SITE-1';
  select id into site_a2 from site where organization_id = org_a and code = 'SITE-2';
  select id into dep_a1_prod from department where site_id = site_a1 and code = 'PROD';
  select id into dep_a1_maint from department where site_id = site_a1 and code = 'MAINT';
  select id into dep_a2_prod from department where site_id = site_a2 and code = 'PROD';
  select id into team_a1 from team where site_id = site_a1 and code = 'TIM-PROD';
  select id into pos_helper from job_position where organization_id = org_a and code = 'HELPER' and status = 'ACTIVE';
  select id into ctr_a from contractor where organization_id = org_a and code = 'KTR-A';
  select id into u_adm_a from user_profile where organization_id = org_a and email like 'admin@%';
  select id into u_spvtim from user_profile where organization_id = org_a and email like 'spvtim1@%';
  select id into u_spv_a from user_profile where organization_id = org_a and email like 'spv1@%';
  select id into u_wrk_a from user_profile where organization_id = org_a and email like 'pekerja1@%';
  select id into w_linked from worker where user_id = u_wrk_a;

  -- W1 seed konsisten: SHO ID berformat dan unik, nomor pekerja ada, tepat satu penempatan berjalan sama dengan proyeksi
  select count(*) into n from worker w join organization o on o.id = w.organization_id
  where w.sho_id !~ ('^SHO-' || o.code || '-[0-9]{6}$');
  if n <> 0 then raise exception 'W1 GAGAL: % SHO ID tidak berformat', n; end if;
  select count(*) into n from worker w
  where (select count(*) from worker_assignment a where a.worker_id = w.id and a.effective_until is null) <> 1
     or exists (select 1 from worker_assignment a where a.worker_id = w.id and a.effective_until is null
                and (a.site_id, a.department_id, a.job_position_id) is distinct from (w.site_id, w.department_id, w.job_position_id));
  if n <> 0 then raise exception 'W1 GAGAL: % pekerja tanpa penempatan berjalan yang cocok', n; end if;
  if exists (select 1 from worker w where w.employment_status = 'CONTRACTOR' and w.organization_id = org_a
             and exists (select 1 from contractor_site cs where cs.contractor_id = w.contractor_id and cs.valid_until is null)
             and not exists (select 1 from contractor_site cs where cs.contractor_id = w.contractor_id and cs.site_id = w.site_id
                             and cs.valid_until is null)) then
    raise exception 'W1 GAGAL: pekerja kontraktor seed di luar Site terhubung';
  end if;
  checks := checks + 3;

  -- W2 SHO ID dibuat sistem (nilai yang dikirim diabaikan) dan tidak dapat diubah (ER-004)
  insert into worker (organization_id, site_id, full_name, employee_number, employment_status, join_date, department_id, job_position_id, sho_id)
  values (org_a, site_a1, 'Pekerja Uji Baru', 'UJI-0001', 'PERMANENT', current_date, dep_a1_maint, pos_helper, 'SHO-PALSU-1')
  returning id, sho_id into w_new, v_sho;
  if v_sho = 'SHO-PALSU-1' or v_sho !~ '^SHO-[A-Z0-9-]+-[0-9]{6}$' then raise exception 'W2 GAGAL: SHO ID tidak dibuat sistem (%)', v_sho; end if;
  begin
    update worker set sho_id = 'SHO-UBAH-000001' where id = w_new;
    raise exception 'W2 GAGAL: SHO ID dapat diubah';
  exception when check_violation then null;
  end;
  if (select count(*) from worker_assignment where worker_id = w_new and effective_until is null and reason = 'INITIAL') <> 1 then
    raise exception 'W2 GAGAL: pekerja baru tanpa penempatan awal';
  end if;
  begin
    insert into worker (organization_id, site_id, full_name, employee_number, employment_status, join_date)
    values (org_a, site_a1, 'Nomor Ganda', 'UJI-0001', 'PERMANENT', current_date);
    raise exception 'W2 GAGAL: nomor pekerja ganda diterima (ER-005)';
  exception when unique_violation then null;
  end;
  insert into worker (organization_id, site_id, full_name, employee_number, employment_status, join_date)
  values (org_b, (select id from site where organization_id = org_b and code = 'SITE-1'), 'Nomor sama org lain', 'UJI-0001', 'PERMANENT', current_date);
  checks := checks + 4;

  -- W3 ER-012: CONTRACTOR wajib kontraktor, dan sebaliknya
  begin
    insert into worker (organization_id, site_id, full_name, employee_number, employment_status, join_date)
    values (org_a, site_a1, 'Kontraktor Tanpa Perusahaan', 'UJI-0002', 'CONTRACTOR', current_date);
    raise exception 'W3 GAGAL: CONTRACTOR tanpa contractor_id diterima';
  exception when check_violation then null;
  end;
  begin
    insert into worker (organization_id, site_id, full_name, employee_number, employment_status, contractor_id, join_date)
    values (org_a, site_a1, 'Tetap Dengan Kontraktor', 'UJI-0003', 'PERMANENT', ctr_a, current_date);
    raise exception 'W3 GAGAL: PERMANENT dengan contractor_id diterima';
  exception when check_violation then null;
  end;
  checks := checks + 2;

  -- W4 ER-013: pekerja kontraktor hanya pada Site yang terhubung, saat dibuat maupun saat dipindah
  begin
    insert into worker (organization_id, site_id, full_name, employee_number, employment_status, contractor_id, join_date)
    values (org_a, site_a2, 'Kontraktor Site 2', 'UJI-0004', 'CONTRACTOR', ctr_a, current_date);
    raise exception 'W4 GAGAL: pekerja kontraktor di Site tidak terhubung diterima';
  exception when check_violation then null;
  end;
  select id into w_ctr from worker where organization_id = org_a and contractor_id = ctr_a limit 1;
  begin
    insert into worker_assignment (organization_id, worker_id, site_id, department_id, effective_from, reason)
    values (org_a, w_ctr, site_a2, dep_a2_prod, current_date + 1, 'MUTASI');
    raise exception 'W4 GAGAL: mutasi pekerja kontraktor ke Site tidak terhubung diterima';
  exception when check_violation then null;
  end;
  checks := checks + 2;

  -- W5 penempatan: menutup penempatan lama, memperbarui proyeksi, data turunan ikut pindah Site; tumpang tindih ditolak
  select w.id into w_notteam from worker w where w.organization_id = org_a and w.site_id = site_a1 and w.employment_status = 'PERMANENT'
    and exists (select 1 from competency_record c where c.worker_id = w.id) limit 1;
  insert into worker_assignment (organization_id, worker_id, site_id, department_id, job_position_id, effective_from, reason)
  values (org_a, w_notteam, site_a2, dep_a2_prod, pos_helper, current_date + 10, 'MUTASI');
  select * into r from worker where id = w_notteam;
  if r.site_id <> site_a2 or r.department_id <> dep_a2_prod or r.job_position_id <> pos_helper then
    raise exception 'W5 GAGAL: proyeksi penempatan worker tidak diperbarui';
  end if;
  if not exists (select 1 from worker_assignment where worker_id = w_notteam and effective_until = current_date + 9) then
    raise exception 'W5 GAGAL: penempatan lama tidak ditutup sehari sebelum tanggal berlaku';
  end if;
  if exists (select 1 from competency_record where worker_id = w_notteam and site_id <> site_a2) then
    raise exception 'W5 GAGAL: data turunan tidak ikut pindah Site';
  end if;
  begin
    insert into worker_assignment (organization_id, worker_id, site_id, department_id, effective_from, effective_until, reason)
    values (org_a, w_notteam, site_a1, dep_a1_prod, current_date + 5, current_date + 20, 'MUNDUR');
    raise exception 'W5 GAGAL: penempatan tumpang tindih diterima (ER-011)';
  exception when exclusion_violation then null;
  end;
  begin
    insert into worker_assignment (organization_id, worker_id, site_id, department_id, effective_from, reason)
    values (org_a, w_notteam, site_a1, dep_a2_prod, current_date + 30, 'SILANG');
    raise exception 'W5 GAGAL: department Site lain diterima pada penempatan';
  exception when foreign_key_violation then null;
  end;
  checks := checks + 5;

  -- W6 ER-008: menonaktifkan pekerja menonaktifkan akun terkait
  update worker set worker_status = 'INACTIVE' where id = w_linked;
  if (select status from user_profile where id = u_wrk_a) <> 'DEACTIVATED' then raise exception 'W6 GAGAL: akun pekerja tidak dinonaktifkan'; end if;
  begin
    update worker set worker_status = 'RESIGNED' where id = w_new;
    raise exception 'W6 GAGAL: RESIGNED tanpa exit_date diterima';
  exception when check_violation then null;
  end;
  checks := checks + 2;

  -- W7 struktur yang masih memiliki pekerja aktif tidak dapat dinonaktifkan (ORG-API-004, BR-WF001-009)
  begin
    update department set status = 'INACTIVE' where id = dep_a1_prod;
    raise exception 'W7 GAGAL: department berpekerja aktif dapat dinonaktifkan';
  exception when check_violation then null;
  end;
  begin
    update site set status = 'INACTIVE' where id = site_a1;
    raise exception 'W7 GAGAL: Site berpekerja aktif dapat dinonaktifkan';
  exception when check_violation then null;
  end;
  begin
    update team set status = 'INACTIVE' where id = team_a1;
    raise exception 'W7 GAGAL: team beranggota aktif dapat dinonaktifkan';
  exception when check_violation then null;
  end;
  begin
    update job_position set status = 'INACTIVE' where id = pos_helper;
    raise exception 'W7 GAGAL: posisi berpekerja aktif dapat dinonaktifkan';
  exception when check_violation then null;
  end;
  checks := checks + 4;

  -- W8 NIK: tidak dapat dibaca peran aplikasi; pasangan terenkripsi+HMAC wajib; HMAC unik per organisasi
  begin
    insert into worker (organization_id, site_id, full_name, employee_number, employment_status, join_date, national_id_encrypted)
    values (org_a, site_a1, 'NIK Tanpa Hash', 'UJI-0005', 'PERMANENT', current_date, '\x01');
    raise exception 'W8 GAGAL: NIK terenkripsi tanpa HMAC diterima';
  exception when check_violation then null;
  end;
  update worker set national_id_encrypted = '\x0102', national_id_hash = '\xaa' where id = w_new;
  begin
    update worker set national_id_encrypted = '\x0103', national_id_hash = '\xaa' where id = w_notteam;
    raise exception 'W8 GAGAL: NIK ganda (HMAC sama) diterima';
  exception when unique_violation then null;
  end;
  set local role app_authenticated;
  perform set_config('app.user_id', u_adm_a::text, true);
  begin
    perform national_id_encrypted from worker where id = w_new;
    raise exception 'W8 GAGAL: NIK terenkripsi dapat dibaca aplikasi';
  exception when insufficient_privilege then null;
  end;
  begin
    perform national_id_hash from worker where id = w_new;
    raise exception 'W8 GAGAL: HMAC NIK dapat dibaca aplikasi';
  exception when insufficient_privilege then null;
  end;
  -- W10 penempatan tidak dapat diubah langsung (hanya lewat worker_assignment)
  begin
    update worker set site_id = site_a2 where id = w_new;
    raise exception 'W10 GAGAL: Site pekerja dapat diubah langsung';
  exception when insufficient_privilege then null;
  end;
  begin
    update worker set sho_id = 'X' where id = w_new;
    raise exception 'W10 GAGAL: SHO ID dapat diubah aplikasi';
  exception when insufficient_privilege then null;
  end;
  checks := checks + 7;

  -- W9 scope Tim Supervisor (PB-008): hanya anggota aktif team-nya; keluar dari team = tidak terlihat
  reset role;
  select array_agg(worker_id) into v_members from team_member where team_id = team_a1 and valid_until is null and valid_from <= current_date;
  select v_members[1] into w_team;
  set local role app_authenticated;
  perform set_config('app.user_id', u_spvtim::text, true);
  select count(*) into n from worker;
  if n <> cardinality(v_members) then raise exception 'W9 GAGAL: Supervisor Tim melihat % pekerja, anggota team %', n, cardinality(v_members); end if;
  if exists (select 1 from worker w where not (w.id = any (v_members))) then
    raise exception 'W9 GAGAL: Supervisor Tim melihat pekerja di luar team-nya';
  end if;
  if not exists (select 1 from worker_assignment where worker_id = w_team) then raise exception 'W9 GAGAL: penempatan anggota team tidak terlihat'; end if;
  reset role;
  update team_member set valid_until = current_date - 1 where team_id = team_a1 and worker_id = w_team and valid_until is null;
  set local role app_authenticated;
  perform set_config('app.user_id', u_spvtim::text, true);
  if exists (select 1 from worker where id = w_team) then raise exception 'W9 GAGAL: pekerja yang keluar team masih terlihat'; end if;
  -- Supervisor scope Site tetap melihat seluruh Site-nya
  perform set_config('app.user_id', u_spv_a::text, true);
  if not exists (select 1 from worker where id = w_team) then raise exception 'W9 GAGAL: Supervisor Site kehilangan pekerja Site-nya'; end if;
  reset role;
  checks := checks + 4;

  -- W12 scope TEAM/DEPARTMENT harus menunjuk objek organisasi yang sama
  begin
    insert into user_role_assignment (user_id, organization_id, role_code, scope_type, scope_id, granted_by)
    values (u_spv_a, org_a, 'SUPERVISOR', 'TEAM', (select id from team where organization_id = org_b limit 1), u_adm_a);
    raise exception 'W12 GAGAL: scope team organisasi lain diterima';
  exception when foreign_key_violation then null;
  end;
  checks := checks + 1;

  -- W11 audit: create, assign, deactivate; NIK hanya nama field (AUD-003)
  if not exists (select 1 from audit_outbox where payload->>'action' = 'worker.create' and (payload->>'entity_id')::uuid = w_new) then
    raise exception 'W11 GAGAL: worker.create tidak tercatat';
  end if;
  if not exists (select 1 from audit_outbox where payload->>'action' = 'worker.assign' and (payload->>'entity_id')::uuid = w_notteam
                 and payload->'changes'->>'reason' = 'MUTASI') then
    raise exception 'W11 GAGAL: worker.assign tidak tercatat';
  end if;
  if not exists (select 1 from audit_outbox where payload->>'action' = 'worker.deactivate' and (payload->>'entity_id')::uuid = w_linked) then
    raise exception 'W11 GAGAL: worker.deactivate tidak tercatat';
  end if;
  if not exists (select 1 from audit_outbox where (payload->>'entity_id')::uuid = w_new and payload->'changed_fields' ? 'national_id')
     or exists (select 1 from audit_outbox where payload::text like '%national_id_encrypted%' or payload::text like '%national_id_hash%') then
    raise exception 'W11 GAGAL: NIK tidak tercatat sebagai nama field saja';
  end if;
  checks := checks + 4;

  raise notice 'LULUS: % pemeriksaan pekerja', checks;
end
$test$;

rollback;

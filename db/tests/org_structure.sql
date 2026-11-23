-- org_structure.sql: uji migrasi 0009 (DB-001 §2-§7, §10; API-002 §9-§10; PB-009). Keluaran akhir: NOTICE "LULUS".
-- Prasyarat: migrasi diterapkan dan seed kecil dimuat (minimal 2 organisasi, 3 Site). Semua perubahan dibatalkan.
\set ON_ERROR_STOP on

begin;

do $test$
declare
  org_a uuid; org_b uuid; site_a1 uuid; site_a2 uuid; site_b1 uuid;
  u_adm_a uuid; u_spv_a uuid; u_mgr_a uuid; u_adm_b uuid;
  dep_a1 uuid; dep_a2 uuid; team_a1 uuid; w_a1 uuid; ctr_a uuid; v_id uuid;
  n bigint; rc bigint; checks int := 0;
begin
  select id into org_a from organization order by name limit 1;
  select id into org_b from organization order by name offset 1 limit 1;
  select id into site_a1 from site where organization_id = org_a and code = 'SITE-1';
  select id into site_a2 from site where organization_id = org_a and code = 'SITE-2';
  select id into site_b1 from site where organization_id = org_b and code = 'SITE-1';
  select id into u_adm_a from user_profile where organization_id = org_a and email like 'admin@%';
  select id into u_spv_a from user_profile where organization_id = org_a and email like 'spv1@%';
  select id into u_mgr_a from user_profile where organization_id = org_a and email like 'hsemgr@%';
  select id into u_adm_b from user_profile where organization_id = org_b and email like 'admin@%';
  select id into dep_a1 from department where site_id = site_a1 and code = 'PROD';
  select id into dep_a2 from department where site_id = site_a2 and code = 'PROD';
  select id into team_a1 from team where site_id = site_a1 and code = 'TIM-PROD';
  select id into w_a1 from worker where site_id = site_a1 order by full_name limit 1;
  select id into ctr_a from contractor where organization_id = org_a;

  -- S1 zona waktu IANA wajib valid (ORG-API-006, ER-010)
  begin
    update site set timezone = 'Mars/Olympus' where id = site_a1;
    raise exception 'S1 GAGAL: zona waktu tidak valid diterima pada Site';
  exception when check_violation then null;
  end;
  begin
    update organization set default_timezone = 'WIB' where id = org_a;
    raise exception 'S1 GAGAL: zona waktu tidak valid diterima pada organisasi';
  exception when check_violation then null;
  end;
  update site set timezone = 'Asia/Makassar' where id = site_a1;
  checks := checks + 3;

  -- S2 kode: format, unik di antara yang aktif dalam induknya, boleh dipakai ulang setelah nonaktif (ORG-API-001)
  begin
    insert into job_position (organization_id, name, code) values (org_a, 'Posisi Uji', 'kecil');
    raise exception 'S2 GAGAL: kode huruf kecil diterima';
  exception when check_violation then null;
  end;
  begin
    insert into job_position (organization_id, name, code) values (org_a, 'Posisi Uji', 'WELDER');
    raise exception 'S2 GAGAL: kode posisi ganda diterima';
  exception when unique_violation then null;
  end;
  insert into job_position (organization_id, name, code) values (org_b, 'Welder Org B', 'WELDER-X');
  update job_position set status = 'INACTIVE' where organization_id = org_a and code = 'HELPER';
  insert into job_position (organization_id, name, code) values (org_a, 'Helper Baru', 'HELPER');
  begin
    insert into department (organization_id, site_id, name, code) values (org_a, site_a1, 'Produksi Dua', 'PROD');
    raise exception 'S2 GAGAL: kode department ganda dalam satu Site diterima';
  exception when unique_violation then null;
  end;
  insert into department (organization_id, site_id, name, code) values (org_a, site_a2, 'Kode sama Site lain', 'MAINT-2');
  checks := checks + 5;

  -- S3 hierarki dalam organisasi dan Site yang sama (ER-001, BR-WF001-003/004/008)
  begin
    insert into department (organization_id, site_id, name, code) values (org_a, site_b1, 'Silang Tenant', 'SILANG');
    raise exception 'S3 GAGAL: department pada Site organisasi lain diterima';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into team (organization_id, site_id, department_id, name, code) values (org_a, site_a1, dep_a2, 'Tim Silang', 'TIM-X');
    raise exception 'S3 GAGAL: team dengan department Site lain diterima';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into division (organization_id, site_id, department_id, name, code) values (org_a, site_a1, dep_a2, 'Divisi Silang', 'DIV-X');
    raise exception 'S3 GAGAL: division dengan department Site lain diterima';
  exception when foreign_key_violation then null;
  end;
  checks := checks + 3;

  -- S4 keanggotaan team bertanggal tanpa tumpang tindih (API-002 §10)
  insert into team_member (organization_id, team_id, worker_id, valid_from, valid_until) values (org_a, team_a1, w_a1, '2026-01-01', '2026-03-31');
  begin
    insert into team_member (organization_id, team_id, worker_id, valid_from) values (org_a, team_a1, w_a1, '2026-03-15');
    raise exception 'S4 GAGAL: keanggotaan tumpang tindih diterima';
  exception when exclusion_violation then null;
  end;
  insert into team_member (organization_id, team_id, worker_id, valid_from) values (org_a, team_a1, w_a1, '2026-04-01');
  begin
    insert into team_member (organization_id, team_id, worker_id, valid_from, valid_until) values (org_a, team_a1, w_a1, '2025-05-01', '2025-04-01');
    raise exception 'S4 GAGAL: rentang terbalik diterima';
  exception when check_violation then null;
  end;
  checks := checks + 3;

  -- S5 kontraktor: hubungan Site aktif tidak ganda, rentang kontrak valid (B-23)
  begin
    insert into contractor_site (organization_id, contractor_id, site_id) values (org_a, ctr_a, site_a1);
    raise exception 'S5 GAGAL: hubungan kontraktor-Site aktif ganda diterima';
  exception when unique_violation then null;
  end;
  begin
    insert into contractor (organization_id, name, code, contract_start, contract_end) values (org_a, 'Kontrak Terbalik', 'KTR-Z', '2026-12-01', '2026-01-01');
    raise exception 'S5 GAGAL: kontrak terbalik diterima';
  exception when check_violation then null;
  end;
  checks := checks + 2;

  -- S6 RLS dan hak
  set local role app_authenticated;
  -- Supervisor Site 1: organization.read scope Site -> hanya struktur Site 1; tidak boleh menulis; tanpa contractor.read
  perform set_config('app.user_id', u_spv_a::text, true);
  select count(*) into n from department where site_id <> site_a1;
  if n <> 0 then raise exception 'S6 GAGAL: Supervisor melihat % department Site lain', n; end if;
  if not exists (select 1 from department where site_id = site_a1) then raise exception 'S6 GAGAL: Supervisor tidak melihat department Site-nya'; end if;
  if exists (select 1 from team where site_id <> site_a1) then raise exception 'S6 GAGAL: Supervisor melihat team Site lain'; end if;
  if not exists (select 1 from job_position) then raise exception 'S6 GAGAL: Supervisor tidak melihat Job Position'; end if;
  if exists (select 1 from contractor) then raise exception 'S6 GAGAL: Supervisor tanpa contractor.read melihat kontraktor'; end if;
  begin
    insert into department (organization_id, site_id, name, code) values (org_a, site_a1, 'Dept Supervisor', 'DEPT-SPV');
    raise exception 'S6 GAGAL: Supervisor dapat membuat department';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into job_position (organization_id, name, code) values (org_a, 'Posisi Supervisor', 'POS-SPV');
    raise exception 'S6 GAGAL: Supervisor dapat membuat Job Position';
  exception when insufficient_privilege then null;
  end;
  update site set name = 'Diubah Supervisor' where id = site_a1;
  get diagnostics rc = row_count;
  if rc <> 0 then raise exception 'S6 GAGAL: Supervisor dapat mengubah Site'; end if;
  update organization set name = 'Diubah Supervisor' where id = org_a;
  get diagnostics rc = row_count;
  if rc <> 0 then raise exception 'S6 GAGAL: Supervisor dapat mengubah organisasi'; end if;
  -- HSE Manager: contractor.read dan contractor.manage
  perform set_config('app.user_id', u_mgr_a::text, true);
  if not exists (select 1 from contractor) then raise exception 'S6 GAGAL: HSE Manager tidak melihat kontraktor'; end if;
  -- Company Admin: membuat struktur dan mengubah organisasi
  perform set_config('app.user_id', u_adm_a::text, true);
  insert into department (organization_id, site_id, name, code) values (org_a, site_a1, 'K3 Lingkungan', 'K3L') returning id into v_id;
  insert into job_position (organization_id, name, code) values (org_a, 'Pengawas Lapangan', 'PENGAWAS');
  update organization set default_timezone = 'Asia/Makassar' where id = org_a;
  get diagnostics rc = row_count;
  if rc <> 1 then raise exception 'S6 GAGAL: Company Admin tidak dapat mengubah zona waktu bawaan'; end if;
  begin
    insert into department (organization_id, site_id, name, code) values (org_b, site_b1, 'Silang Admin', 'SILANG2');
    raise exception 'S6 GAGAL: Company Admin A menulis struktur organisasi B';
  exception when insufficient_privilege then null;
  end;
  -- Admin organisasi B tidak melihat struktur A
  perform set_config('app.user_id', u_adm_b::text, true);
  if exists (select 1 from department where organization_id = org_a) or exists (select 1 from job_position where organization_id = org_a)
     or exists (select 1 from contractor where organization_id = org_a) or exists (select 1 from team_member where organization_id = org_a) then
    raise exception 'S6 GAGAL: struktur organisasi A terlihat oleh organisasi B';
  end if;
  checks := checks + 13;

  -- S7 tanpa penghapusan fisik (ORG-API-003)
  perform set_config('app.user_id', u_adm_a::text, true);
  begin
    delete from department where id = v_id;
    raise exception 'S7 GAGAL: department dapat dihapus';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from contractor where id = ctr_a;
    raise exception 'S7 GAGAL: kontraktor dapat dihapus';
  exception when insufficient_privilege then null;
  end;
  update department set status = 'INACTIVE' where id = v_id;
  reset role;
  checks := checks + 2;

  -- S8 setiap perubahan tercatat di audit dengan pelaku, role, dan Site (ORG-API-010)
  if not exists (select 1 from audit_outbox where payload->>'action' = 'department.create' and (payload->>'entity_id')::uuid = v_id
                 and (payload->>'actor_user_id')::uuid = u_adm_a and payload->>'actor_role_code' = 'COMPANY_ADMIN'
                 and (payload->>'site_id')::uuid = site_a1) then
    raise exception 'S8 GAGAL: department.create tidak tercatat lengkap';
  end if;
  if not exists (select 1 from audit_outbox where payload->>'action' = 'department.deactivate' and (payload->>'entity_id')::uuid = v_id
                 and payload->'changes'->'status'->>'to' = 'INACTIVE') then
    raise exception 'S8 GAGAL: department.deactivate tidak tercatat';
  end if;
  if not exists (select 1 from audit_outbox where payload->>'action' = 'team.member_add') then
    raise exception 'S8 GAGAL: team.member_add tidak tercatat';
  end if;
  update team_member set valid_until = '2026-12-31' where team_id = team_a1 and valid_until is null;
  if not exists (select 1 from audit_outbox where payload->>'action' = 'team.member_end') then
    raise exception 'S8 GAGAL: team.member_end tidak tercatat';
  end if;
  if not exists (select 1 from audit_outbox where payload->>'action' = 'organization.update' and payload->'changes' ? 'default_timezone') then
    raise exception 'S8 GAGAL: organization.update tidak tercatat';
  end if;
  checks := checks + 5;

  raise notice 'LULUS: % pemeriksaan struktur organisasi', checks;
end
$test$;

rollback;

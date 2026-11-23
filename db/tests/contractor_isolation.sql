-- contractor_isolation.sql: uji isolasi antar-kontraktor (SRS-PPL003 FR-003, AC-PPL003-002/003/005/010; RLS-007; migrasi 0013).
-- CONTRACTOR_ADMIN tidak aktif dan tanpa permission sampai P2. Uji ini mengaktifkan jalur scope CONTRACTOR
-- hanya di dalam transaksi (izin sementara, peran uji sintetis) lalu membatalkan semuanya.
\set ON_ERROR_STOP on

begin;

do $test$
declare
  org_a uuid; org_b uuid; u_adm uuid; u_hseo uuid; u_spv uuid; ctr_a uuid; ctr_b uuid; ctr_b_org_b uuid;
  ca_a uuid; ca_b uuid; ura_a uuid; n bigint; m bigint; checks int := 0;
begin
  select id into org_a from organization order by name limit 1;
  select id into org_b from organization order by name offset 1 limit 1;
  select id into u_adm from user_profile where organization_id = org_a and email like 'admin@%';
  select id into u_hseo from user_profile where organization_id = org_a and email like 'hseo1@%';
  select id into u_spv from user_profile where organization_id = org_a and email like 'spv1@%';
  select id into ctr_a from contractor where organization_id = org_a and code = 'KTR-A';
  select id into ctr_b from contractor where organization_id = org_a and code = 'KTR-B';
  select id into ctr_b_org_b from contractor where organization_id = org_b and code = 'KTR-B';

  -- C0 data uji: minimal dua kontraktor per organisasi, masing-masing punya pekerja (FR-PPL003-004)
  if ctr_a is null or ctr_b is null then raise exception 'C0 GAGAL: seed tanpa dua kontraktor'; end if;
  if not exists (select 1 from worker where contractor_id = ctr_a) or not exists (select 1 from worker where contractor_id = ctr_b) then
    raise exception 'C0 GAGAL: kontraktor tanpa pekerja sintetis';
  end if;
  checks := checks + 1;

  insert into user_profile(organization_id, email, full_name, status)
  values (org_a, 'ktr-a-admin@uji.contoh', 'Admin Kontraktor A Uji', 'ACTIVE'),
         (org_a, 'ktr-b-admin@uji.contoh', 'Admin Kontraktor B Uji', 'ACTIVE');
  select id into ca_a from user_profile where email = 'ktr-a-admin@uji.contoh';
  select id into ca_b from user_profile where email = 'ktr-b-admin@uji.contoh';

  -- C1 sebelum P2: penugasan Contractor Admin ditolak ROLE_NOT_ACTIVE (AC-PPL003-005)
  begin
    insert into user_role_assignment(user_id, organization_id, role_code, scope_type, scope_id, granted_by)
    values (ca_a, org_a, 'CONTRACTOR_ADMIN', 'CONTRACTOR', ctr_a, u_adm);
    raise exception 'C1 GAGAL: Contractor Admin diterima sebelum P2';
  exception when check_violation then
    if sqlerrm not like 'ROLE_NOT_ACTIVE%' then raise exception 'C1 GAGAL: galat bukan ROLE_NOT_ACTIVE (%)', sqlerrm; end if;
  end;
  checks := checks + 1;

  -- persiapan jalur scope CONTRACTOR (hanya dalam transaksi uji)
  perform set_config('app.allow_inactive_roles', 'on', true);
  insert into role_permission(role_code, permission_code, constraint_level)
  values ('CONTRACTOR_ADMIN', 'worker.read', 'FULL'), ('CONTRACTOR_ADMIN', 'contractor.read', 'FULL')
  on conflict do nothing;
  insert into user_role_assignment(user_id, organization_id, role_code, scope_type, scope_id, granted_by)
  values (ca_a, org_a, 'CONTRACTOR_ADMIN', 'CONTRACTOR', ctr_a, u_adm) returning id into ura_a;
  insert into user_role_assignment(user_id, organization_id, role_code, scope_type, scope_id, granted_by)
  values (ca_b, org_a, 'CONTRACTOR_ADMIN', 'CONTRACTOR', ctr_b, u_adm);

  -- C2 scope kontraktor organisasi lain ditolak (BR-PPL003-004)
  begin
    insert into user_role_assignment(user_id, organization_id, role_code, scope_type, scope_id, granted_by)
    values (ca_b, org_a, 'CONTRACTOR_ADMIN', 'CONTRACTOR', ctr_b_org_b, u_adm);
    raise exception 'C2 GAGAL: scope kontraktor organisasi lain diterima';
  exception when foreign_key_violation then null;
  end;
  checks := checks + 1;

  set local role app_authenticated;

  -- C3 kontraktor A: hanya pekerja kontraktor A; bukan B, bukan non-kontraktor, bukan organisasi lain (AC-002/003)
  perform set_config('app.user_id', ca_a::text, true);
  select count(*) into n from worker;
  if n = 0 then raise exception 'C3 GAGAL: Contractor Admin A tidak melihat pekerjanya'; end if;
  if exists (select 1 from worker where contractor_id is distinct from ctr_a) then
    raise exception 'C3 GAGAL: Contractor Admin A melihat pekerja di luar kontraktornya';
  end if;
  reset role;
  select count(*) into m from worker where contractor_id = ctr_a;
  set local role app_authenticated;
  perform set_config('app.user_id', ca_a::text, true);
  if n <> m then raise exception 'C3 GAGAL: Contractor Admin A melihat % dari % pekerjanya', n, m; end if;
  if exists (select 1 from worker_assignment a where not exists (select 1 from worker w where w.id = a.worker_id)) then
    raise exception 'C3 GAGAL: penempatan pekerja lain terlihat';
  end if;
  if (select count(*) from contractor) <> 1 or not exists (select 1 from contractor where id = ctr_a) then
    raise exception 'C3 GAGAL: Contractor Admin A melihat kontraktor lain';
  end if;
  if exists (select 1 from contractor_site where contractor_id <> ctr_a) then
    raise exception 'C3 GAGAL: relasi Site kontraktor lain terlihat';
  end if;
  if exists (select 1 from site) or exists (select 1 from user_profile where id <> ca_a) then
    raise exception 'C3 GAGAL: Contractor Admin melihat struktur atau pengguna lain';
  end if;
  checks := checks + 5;

  -- C4 tidak dapat mengubah pekerja kontraktor B (atau pekerja mana pun sebelum P2) (AC-002)
  update worker set full_name = 'Diubah Kontraktor' where contractor_id = ctr_b;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'C4 GAGAL: Contractor Admin A mengubah % pekerja B', n; end if;
  update worker set full_name = 'Diubah Sendiri' where contractor_id = ctr_a;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'C4 GAGAL: Contractor Admin mengubah pekerja tanpa permission P2'; end if;
  checks := checks + 2;

  -- C5 kontraktor B simetris
  perform set_config('app.user_id', ca_b::text, true);
  if exists (select 1 from worker where contractor_id is distinct from ctr_b) or not exists (select 1 from worker) then
    raise exception 'C5 GAGAL: isolasi Contractor Admin B';
  end if;
  if exists (select 1 from contractor where id <> ctr_b) then raise exception 'C5 GAGAL: Contractor Admin B melihat kontraktor lain'; end if;
  checks := checks + 2;

  -- C6 staf perusahaan tetap melihat semua kontraktor organisasinya; tanpa contractor.read tidak melihat (B-23, PB-009)
  perform set_config('app.user_id', u_hseo::text, true);
  if (select count(*) from contractor) < 2 then raise exception 'C6 GAGAL: HSE Officer Site tidak melihat kontraktor organisasi'; end if;
  perform set_config('app.user_id', u_spv::text, true);
  if exists (select 1 from contractor) then raise exception 'C6 GAGAL: Supervisor tanpa contractor.read melihat kontraktor'; end if;
  checks := checks + 2;

  -- C7 pencabutan penugasan berlaku pada kueri berikutnya (AR-010)
  reset role;
  update user_role_assignment set revoked_at = now(), revoked_by = u_adm where id = ura_a;
  set local role app_authenticated;
  perform set_config('app.user_id', ca_a::text, true);
  if exists (select 1 from worker) or exists (select 1 from contractor) then
    raise exception 'C7 GAGAL: penugasan dicabut tetapi masih melihat data kontraktor';
  end if;
  reset role;
  checks := checks + 1;

  raise notice 'LULUS: % pemeriksaan isolasi kontraktor', checks;
end
$test$;

rollback;

-- audit_trail.sql: uji migrasi 0007 (SRS-PLT03, DB-007 §2 dan §5). Keluaran akhir: NOTICE "LULUS".
-- Prasyarat: migrasi diterapkan dan seed kecil dimuat (minimal 2 organisasi). Semua perubahan dibatalkan.
\set ON_ERROR_STOP on

begin;

do $test$
declare
  org_a uuid; org_b uuid; site_a1 uuid;
  u_adm_a uuid; u_adm_b uuid; u_spv_a uuid; u_mgr_a uuid; u_hseo_a uuid;
  v_ura uuid; v_ev uuid; v_bad uuid; v_sess uuid := gen_random_uuid();
  t record; n bigint; ok boolean; checks int := 0;
begin
  select id into org_a from organization order by name limit 1;
  select id into org_b from organization order by name offset 1 limit 1;
  select id into u_adm_a from user_profile where organization_id = org_a and email like 'admin@%';
  select id into u_adm_b from user_profile where organization_id = org_b and email like 'admin@%';
  select id into u_spv_a from user_profile where organization_id = org_a and email like 'spv1@%';
  select id into u_mgr_a from user_profile where organization_id = org_a and email like 'hsemgr@%';
  select id into u_hseo_a from user_profile where organization_id = org_a and email like 'hseo1@%';
  select id into site_a1 from site where organization_id = org_a order by name limit 1;

  -- B1 struktur: tabel induk dipartisi, partisi bulan berjalan dan bawaan ada, setiap partisi RLS dipaksa
  --    dan punya trigger TRUNCATE sendiri (trigger TRUNCATE tidak merambat dari induk)
  if (select relkind from pg_class where oid = 'audit_log'::regclass) <> 'p' then
    raise exception 'B1 GAGAL: audit_log bukan tabel berpartisi';
  end if;
  if to_regclass('audit_log_' || to_char(now() at time zone 'UTC', 'YYYYMM')) is null
     or to_regclass('audit_log_default') is null then
    raise exception 'B1 GAGAL: partisi bulan berjalan atau bawaan tidak ada';
  end if;
  for t in select c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_inherits i
           join pg_class c on c.oid = i.inhrelid where i.inhparent = 'audit_log'::regclass loop
    if not (t.relrowsecurity and t.relforcerowsecurity) then raise exception 'B1 GAGAL: % tanpa RLS dipaksa', t.relname; end if;
    if not exists (select 1 from pg_trigger where tgrelid = t.oid and tgname = 'audit_log_no_truncate') then
      raise exception 'B1 GAGAL: % tanpa trigger TRUNCATE', t.relname;
    end if;
    if has_table_privilege('app_authenticated', t.oid, 'select,insert,update,delete')
       or has_table_privilege('app_worker', t.oid, 'select,insert,update,delete') then
      raise exception 'B1 GAGAL: peran aplikasi punya hak langsung atas partisi %', t.relname;
    end if;
    checks := checks + 1;
  end loop;

  -- B2 append-only, termasuk untuk pemilik/superuser: UPDATE, DELETE, TRUNCATE induk dan partisi langsung ditolak
  insert into audit_log (organization_id, actor_kind, action, entity_type) values (org_a, 'SYSTEM', 'uji.append', 'uji');
  begin
    update audit_log set action = 'uji.ubah' where action = 'uji.append';
    raise exception 'B2 GAGAL: UPDATE audit diizinkan';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from audit_log where action = 'uji.append';
    raise exception 'B2 GAGAL: DELETE audit diizinkan';
  exception when insufficient_privilege then null;
  end;
  begin
    execute format('truncate %I', 'audit_log_' || to_char(now() at time zone 'UTC', 'YYYYMM'));
    raise exception 'B2 GAGAL: TRUNCATE partisi langsung diizinkan';
  exception when insufficient_privilege then null;
  end;
  begin
    truncate audit_log_default;
    raise exception 'B2 GAGAL: TRUNCATE partisi bawaan diizinkan';
  exception when insufficient_privilege then null;
  end;
  checks := checks + 4;

  -- B3 constraint DB-007: akses sensitif wajib alasan (tidak kosong), SUPPORT wajib izin, USER wajib pelaku
  begin
    insert into audit_log (organization_id, actor_kind, actor_user_id, action, entity_type, sensitive_access, access_reason)
    values (org_a, 'USER', u_adm_a, 'medical.read_detail', 'medical_detail', true, '   ');
    raise exception 'B3 GAGAL: akses sensitif dengan alasan kosong diterima';
  exception when check_violation then null;
  end;
  begin
    insert into audit_log (organization_id, actor_kind, actor_user_id, action, entity_type)
    values (org_a, 'SUPPORT', u_adm_a, 'access.support_used', 'organization');
    raise exception 'B3 GAGAL: SUPPORT tanpa support_grant_id diterima';
  exception when check_violation then null;
  end;
  begin
    insert into audit_log (organization_id, actor_kind, action, entity_type) values (org_a, 'USER', 'worker.update', 'worker');
    raise exception 'B3 GAGAL: kejadian USER tanpa pelaku diterima';
  exception when check_violation then null;
  end;
  begin
    insert into audit_log (organization_id, actor_kind, action, entity_type) values (org_a, 'SYSTEM', 'TIDAK VALID', 'x');
    raise exception 'B3 GAGAL: kode aksi tidak valid diterima';
  exception when check_violation then null;
  end;
  checks := checks + 4;

  -- B4 kejadian otomatis dari trigger, dengan pelaku dan role yang dipakai
  insert into user_role_assignment (user_id, organization_id, role_code, scope_type, granted_by)
  values (u_hseo_a, org_a, 'HSE_MANAGER', 'ORGANIZATION', u_adm_a) returning id into v_ura;
  select count(*) into n from audit_outbox
  where payload->>'action' = 'access.role_assigned' and (payload->>'entity_id')::uuid = v_ura
    and (payload->>'actor_user_id')::uuid = u_adm_a and payload->>'actor_role_code' = 'COMPANY_ADMIN'
    and (payload->>'organization_id')::uuid = org_a and payload->'changes'->>'role_code' = 'HSE_MANAGER';
  if n <> 1 then raise exception 'B4 GAGAL: access.role_assigned tidak tercatat lengkap (%)', n; end if;
  update user_role_assignment set revoked_at = now(), revoked_by = u_adm_a where id = v_ura;
  select count(*) into n from audit_outbox where payload->>'action' = 'access.role_revoked' and (payload->>'entity_id')::uuid = v_ura;
  if n <> 1 then raise exception 'B4 GAGAL: access.role_revoked tidak tercatat'; end if;
  update user_profile set status = 'DEACTIVATED' where id = u_spv_a;
  select count(*) into n from audit_outbox where payload->>'action' = 'user.deactivate'
    and (payload->>'entity_id')::uuid = u_spv_a and payload->'changes'->'status'->>'from' = 'ACTIVE';
  if n <> 1 then raise exception 'B4 GAGAL: user.deactivate tidak tercatat dengan status lama dan baru'; end if;
  update user_profile set status = 'ACTIVE' where id = u_spv_a;
  -- nilai data pribadi tidak disalin: perubahan nama hanya tercatat sebagai nama field
  update user_profile set full_name = 'Nama Rahasia Uji' where id = u_spv_a;
  select count(*) into n from audit_outbox where payload->>'action' = 'user.update' and (payload->>'entity_id')::uuid = u_spv_a
    and payload->'changed_fields' ? 'full_name' and payload::text not like '%Nama Rahasia Uji%';
  if n <> 1 then raise exception 'B4 GAGAL: perubahan nama tidak tercatat atau nilainya tersalin ke audit'; end if;
  checks := checks + 4;

  set local role app_authenticated;
  perform set_config('app.user_id', u_adm_a::text, true);
  perform set_config('app.request_id', 'uji-req-1', true);
  perform set_config('app.ip', '203.0.113.7', true);

  -- B5 peran aplikasi tidak dapat menulis audit langsung atau menjalankan pemindah; audit_record memaksa organisasi
  begin
    insert into audit_log (organization_id, actor_kind, action, entity_type) values (org_b, 'SYSTEM', 'uji.palsu', 'x');
    raise exception 'B5 GAGAL: app_authenticated dapat menulis audit_log';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into audit_outbox (payload) values ('{}');
    raise exception 'B5 GAGAL: app_authenticated dapat menulis audit_outbox';
  exception when insufficient_privilege then null;
  end;
  begin
    perform app.audit_drain(10);
    raise exception 'B5 GAGAL: app_authenticated dapat menjalankan audit_drain';
  exception when insufficient_privilege then null;
  end;
  begin
    perform app.audit_enqueue(org_b, 'uji.palsu', 'x');
    raise exception 'B5 GAGAL: app_authenticated dapat memanggil audit_enqueue (organisasi bebas)';
  exception when insufficient_privilege then null;
  end;
  v_ev := app.audit_record('report.export', 'report', null, array['format'], '{"format": "CSV"}', 'user.manage');
  reset role;
  select count(*) into n from audit_outbox where id = v_ev and (payload->>'organization_id')::uuid = org_a
    and payload->>'request_id' = 'uji-req-1' and payload->>'ip' = '203.0.113.7' and payload->>'actor_kind' = 'USER';
  if n <> 1 then raise exception 'B5 GAGAL: audit_record tidak memakai organisasi dan konteks permintaan pelaku'; end if;
  checks := checks + 5;

  -- B6 pemindah (app_worker): memindahkan, idempoten, dan kejadian rusak masuk antrean gagal tanpa dihapus
  insert into audit_outbox (payload) values ('{"action": "RUSAK", "actor_kind": "SYSTEM", "entity_type": "x"}') returning id into v_bad;
  set local role app_worker;
  perform app.audit_drain(100000);
  for i in 1..4 loop perform app.audit_drain(100000); end loop;
  reset role;
  select count(*) into n from audit_outbox where processed_at is null and failed_at is null;
  if n <> 0 then raise exception 'B6 GAGAL: % kejadian tertinggal di antrean', n; end if;
  if not exists (select 1 from audit_log where id = v_ev and ip = '203.0.113.7'::inet) then
    raise exception 'B6 GAGAL: kejadian audit_record tidak sampai ke audit_log';
  end if;
  if not exists (select 1 from audit_outbox where id = v_bad and failed_at is not null and attempts = 5 and last_error is not null) then
    raise exception 'B6 GAGAL: kejadian rusak tidak masuk antrean gagal setelah 5 percobaan';
  end if;
  select count(*) into n from audit_log where id = v_ev;
  set local role app_worker;
  update audit_outbox set processed_at = null where id = v_ev;  -- paksa diproses ulang
  perform app.audit_drain(100000);
  reset role;
  if (select count(*) from audit_log where id = v_ev) <> n then raise exception 'B6 GAGAL: pemrosesan ulang menggandakan audit'; end if;
  checks := checks + 4;

  -- B7 baca (RLS + audit.view): Company Admin A hanya organisasinya; Supervisor (tanpa audit.view) dan
  --    HSE Manager (audit.view LIMITED, ditolak bawaan) tidak melihat apa pun
  set local role app_authenticated;
  perform set_config('app.user_id', u_adm_a::text, true);
  select count(*) into n from audit_log where organization_id is distinct from org_a;
  if n <> 0 then raise exception 'B7 GAGAL: Company Admin A melihat % audit organisasi lain', n; end if;
  select count(*) into n from audit_log;
  if n = 0 then raise exception 'B7 GAGAL: Company Admin A tidak melihat audit organisasinya'; end if;
  perform set_config('app.user_id', u_spv_a::text, true);
  if (select count(*) from audit_log) <> 0 then raise exception 'B7 GAGAL: Supervisor melihat audit'; end if;
  perform set_config('app.user_id', u_mgr_a::text, true);
  if (select count(*) from audit_log) <> 0 then raise exception 'B7 GAGAL: HSE Manager (LIMITED) melihat audit'; end if;
  perform set_config('app.user_id', u_adm_b::text, true);
  if exists (select 1 from audit_log where id = v_ev) then raise exception 'B7 GAGAL: admin B melihat audit org A'; end if;
  checks := checks + 4;

  -- B8 login: sesi pertama kali dipakai menghasilkan satu auth.login_success, pemakaian berikutnya tidak
  perform set_config('app.user_id', u_adm_a::text, true);
  ok := app.audit_session_seen(v_sess);
  if not ok then raise exception 'B8 GAGAL: sesi baru tidak dikenali'; end if;
  if app.audit_session_seen(v_sess) then raise exception 'B8 GAGAL: sesi yang sama dicatat dua kali'; end if;
  reset role;
  select count(*) into n from audit_outbox where payload->>'action' = 'auth.login_success'
    and (payload->>'actor_user_id')::uuid = u_adm_a and (payload->>'organization_id')::uuid = org_a;
  if n <> 1 then raise exception 'B8 GAGAL: auth.login_success tercatat % kali', n; end if;
  checks := checks + 3;

  raise notice 'LULUS: % pemeriksaan audit', checks;
end
$test$;

rollback;

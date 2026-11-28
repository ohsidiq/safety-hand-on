-- passport.sql: uji migrasi 0024 QR Safety Passport (API-014 bagian 7, FR-RE-013, RDY-API-006/007). Data sintetis.
-- Semua perubahan dibatalkan. Keluaran akhir: NOTICE "LULUS".
\set ON_ERROR_STOP on

begin;

do $test$
declare
  org_a uuid; site_w uuid; today date;
  u_wrk uuid; u_scan uuid; u_far uuid; u_b uuid; u_mgr uuid; u_hseo_far uuid;
  w_self uuid; w_other uuid; pos uuid; cmp uuid; mcu uuid; prof uuid;
  tok text; exp timestamptz; r record; n bigint; checks int := 0;
begin
  select id into org_a from organization order by name limit 1;
  select id into u_wrk from user_profile where organization_id = org_a and email like 'pekerja1@%';
  select id into u_mgr from user_profile where organization_id = org_a and email like 'hsemgr@%';
  select id into u_b from user_profile where organization_id = (select id from organization order by name offset 1 limit 1)
    and email like 'admin@%';
  select id, site_id into w_self, site_w from worker where user_id = u_wrk;
  today := app.site_today(site_w);
  -- pemindai: HSE Officer pada Site pekerja; pembanding: HSE Officer Site lain
  select ura.user_id into u_scan from user_role_assignment ura
   where ura.organization_id = org_a and ura.role_code = 'HSE_OFFICER' and ura.scope_type = 'SITE' and ura.scope_id = site_w
     and ura.revoked_at is null limit 1;
  select ura.user_id into u_far from user_role_assignment ura
   where ura.organization_id = org_a and ura.role_code = 'HSE_OFFICER' and ura.scope_type = 'SITE' and ura.scope_id <> site_w
     and ura.revoked_at is null limit 1;
  select id into w_other from worker where organization_id = org_a and site_id = site_w and id <> w_self
    and worker_status = 'ACTIVE' order by id limit 1;
  if u_scan is null or u_far is null or w_other is null then raise exception 'PRASYARAT GAGAL: pengguna/pekerja uji'; end if;

  -- syarat untuk kategori: kompetensi segera berakhir (ok + peringatan), MCU belum ada (tidak ok)
  insert into job_position (organization_id, name, code) values (org_a, 'Uji Passport', 'UJI-QR') returning id into pos;
  insert into competency (organization_id, name, code) values (org_a, 'Uji QR Kompetensi', 'UJI-QR-CMP') returning id into cmp;
  insert into medical_exam_type (organization_id, name, code) values (org_a, 'Uji QR MCU', 'UJI-QR-MCU') returning id into mcu;
  insert into requirement_profile (organization_id, job_position_id, profile_version) values (org_a, pos, 1) returning id into prof;
  insert into requirement_profile_item (organization_id, profile_id, item_type, competency_id) values (org_a, prof, 'COMPETENCY', cmp);
  insert into requirement_profile_item (organization_id, profile_id, item_type, medical_exam_type_id) values (org_a, prof, 'MEDICAL', mcu);
  update requirement_profile set status = 'ACTIVE' where id = prof;
  update worker set job_position_id = pos where id = w_self;
  insert into worker_competency (organization_id, site_id, worker_id, competency_id, valid_from, valid_until, created_by,
                                 verification_status, verified_by, verified_at)
  values (org_a, site_w, w_self, cmp, today - 100, today + 10, u_scan, 'VERIFIED', u_mgr, now());
  perform app.readiness_evaluate(w_self, 'MANUAL', null);

  set local role app_authenticated;

  -- P1 pekerja menerbitkan token untuk dirinya: 64 heksadesimal, 5 menit, hanya hash yang tersimpan
  perform set_config('app.user_id', u_wrk::text, true);
  select * into tok, exp from app.passport_issue(w_self);
  if tok !~ '^[0-9a-f]{64}$' or exp <= now() + interval '4 minutes' or exp > now() + interval '5 minutes 1 second' then
    raise exception 'P1 GAGAL: token % berlaku sampai %', tok, exp;
  end if;
  reset role;
  if not exists (select 1 from passport_token where worker_id = w_self and token_hash = sha256(convert_to(tok, 'UTF8')))
     or exists (select 1 from passport_token where encode(token_hash, 'hex') = tok) then
    raise exception 'P1 GAGAL: penyimpanan token tidak sesuai (harus hash)';
  end if;
  set local role app_authenticated;
  checks := checks + 2;

  -- P2 pekerja tidak dapat menerbitkan token untuk orang lain
  begin
    perform app.passport_issue(w_other);
    raise exception 'P2 GAGAL: pekerja menerbitkan token orang lain';
  exception when no_data_found then null;
  end;
  checks := checks + 1;

  -- P3 tabel token tidak dapat dibaca langsung
  begin
    perform 1 from passport_token limit 1;
    raise exception 'P3 GAGAL: passport_token dapat dibaca langsung';
  exception when insufficient_privilege then null;
  end;
  checks := checks + 1;

  -- P4 pemindai berwenang: data minimal, kategori tanpa detail medis, tercatat di audit
  perform set_config('app.user_id', u_scan::text, true);
  select * into r from app.passport_verify(tok);
  if r.worker_id is distinct from w_self or r.status is distinct from 'NOT_READY' or r.full_name is null
     or r.job_position is distinct from 'Uji Passport' or r.evaluated_at is null then
    raise exception 'P4 GAGAL: hasil pindai %', row_to_json(r);
  end if;
  if r.categories <> '[{"ok": true, "warning": "EXPIRING_SOON", "item_type": "COMPETENCY"}, {"ok": false, "warning": null, "item_type": "MEDICAL"}]'::jsonb then
    raise exception 'P4 GAGAL: kategori %', r.categories;
  end if;
  reset role;
  if not exists (select 1 from audit_outbox where payload->>'action' = 'passport.scan' and payload->>'entity_id' = w_self::text) then
    raise exception 'P4 GAGAL: pemindaian tidak teraudit';
  end if;
  set local role app_authenticated;
  checks := checks + 3;

  -- P5 pemindai di luar scope, tenant lain, dan pekerja sendiri sebagai pemindai -> NOT_FOUND
  foreach u_hseo_far in array array[u_far, u_b, u_wrk] loop
    perform set_config('app.user_id', u_hseo_far::text, true);
    begin
      perform app.passport_verify(tok);
      raise exception 'P5 GAGAL: % memindai pekerja di luar scope', u_hseo_far;
    exception when no_data_found then null;
    end;
  end loop;
  checks := checks + 3;

  -- P6 HSE Officer menerbitkan token untuk pekerja Site-nya; Site lain ditolak
  perform set_config('app.user_id', u_scan::text, true);
  if (select token from app.passport_issue(w_other)) is null then raise exception 'P6 GAGAL: HSE Officer tidak dapat menerbitkan'; end if;
  perform set_config('app.user_id', u_far::text, true);
  begin
    perform app.passport_issue(w_other);
    raise exception 'P6 GAGAL: HSE Officer Site lain menerbitkan token';
  exception when no_data_found then null;
  end;
  checks := checks + 2;

  -- P7 token rusak, tidak dikenal, dan kedaluwarsa
  perform set_config('app.user_id', u_scan::text, true);
  begin
    perform app.passport_verify('SHO-000001');
    raise exception 'P7 GAGAL: token rusak diterima';
  exception when invalid_authorization_specification then
    if sqlerrm <> 'PASSPORT_TOKEN_INVALID' then raise; end if;
  end;
  begin
    perform app.passport_verify(repeat('a', 64));
    raise exception 'P7 GAGAL: token tidak dikenal diterima';
  exception when invalid_authorization_specification then
    if sqlerrm <> 'PASSPORT_TOKEN_INVALID' then raise; end if;
  end;
  reset role;
  update passport_token set issued_at = now() - interval '10 minutes', expires_at = now() - interval '1 minute'
   where token_hash = sha256(convert_to(tok, 'UTF8'));
  set local role app_authenticated;
  begin
    perform app.passport_verify(tok);
    raise exception 'P7 GAGAL: token kedaluwarsa diterima';
  exception when invalid_authorization_specification then
    if sqlerrm <> 'PASSPORT_TOKEN_EXPIRED' then raise; end if;
  end;
  checks := checks + 3;

  -- P8 pekerja nonaktif tidak diterbitkan token
  reset role;
  update worker set worker_status = 'INACTIVE' where id = w_other;
  set local role app_authenticated;
  perform set_config('app.user_id', u_scan::text, true);
  begin
    perform app.passport_issue(w_other);
    raise exception 'P8 GAGAL: token untuk pekerja nonaktif';
  exception when check_violation then null;
  end;
  checks := checks + 1;
  reset role;

  -- P9 masa berlaku token dibatasi constraint (maksimum 10 menit)
  begin
    insert into passport_token (organization_id, worker_id, token_hash, expires_at)
    values (org_a, w_self, sha256('x'::bytea), now() + interval '1 hour');
    raise exception 'P9 GAGAL: token berumur panjang diterima';
  exception when check_violation then null;
  end;
  checks := checks + 1;

  raise notice 'LULUS: % pemeriksaan QR Safety Passport', checks;
end
$test$;

rollback;

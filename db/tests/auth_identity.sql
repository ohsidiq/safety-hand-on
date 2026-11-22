-- auth_identity.sql: uji migrasi 0006 (B-18, DB-001 §2 dan §8, API-001 §9).
-- Prasyarat: migrasi diterapkan dan seed kecil dimuat (minimal 2 organisasi). Keluaran akhir: "LULUS".
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

do $test$
declare
  org_a uuid; org_b uuid;
  u_adm_a uuid; u_med_a uuid; u_med_b uuid; u_wrk_a uuid; u_wrk_b uuid;
  w_a uuid; w_a2 uuid; w_b uuid;
  n bigint; v uuid; checks int := 0;
begin
  select id into org_a from organization order by name limit 1;
  select id into org_b from organization order by name offset 1 limit 1;
  select id into u_adm_a from user_profile where organization_id = org_a and email like 'admin@%';
  select id into u_med_a from user_profile where organization_id = org_a and email like 'medis@%';
  select id into u_med_b from user_profile where organization_id = org_b and email like 'medis@%';
  select id into u_wrk_a from user_profile where organization_id = org_a and email like 'pekerja1@%';
  select id into u_wrk_b from user_profile where organization_id = org_b and email like 'pekerja1@%';
  select id into w_a from worker where user_id = u_wrk_a;
  select id into w_b from worker where user_id = u_wrk_b;
  select id into w_a2 from worker where organization_id = org_a and user_id is null limit 1;

  -- A1 seed: setiap organisasi punya kode, akun pekerja tertaut ke tepat satu Worker
  select count(*) into n from organization where code is null;
  if n <> 0 then raise exception 'A1 GAGAL: % organisasi tanpa kode', n; end if;
  if w_a is null or w_b is null then raise exception 'A1 GAGAL: akun pekerja sintetis tidak tertaut'; end if;
  checks := checks + 2;

  -- A2 kode organisasi: format dan keunikan
  begin
    update organization set code = 'kecil' where id = org_a;
    raise exception 'A2 GAGAL: kode huruf kecil diterima';
  exception when check_violation then null;
  end;
  begin
    update organization set code = (select code from organization where id = org_b) where id = org_a;
    raise exception 'A2 GAGAL: kode ganda diterima';
  exception when unique_violation then null;
  end;
  checks := checks + 2;

  -- A3 worker.user_id: satu akun paling banyak satu Worker, dan tidak lintas organisasi
  begin
    update worker set user_id = u_wrk_a where id = w_a2;
    raise exception 'A3 GAGAL: satu akun tertaut ke dua Worker';
  exception when unique_violation then null;
  end;
  begin
    update worker set user_id = u_med_b where id = w_a2;
    raise exception 'A3 GAGAL: akun organisasi B tertaut ke Worker organisasi A';
  exception when foreign_key_violation then null;
  end;
  checks := checks + 2;

  -- A4 role WORKER wajib punya Worker (WORKER_REQUIRED_FOR_ROLE)
  begin
    insert into user_role_assignment(user_id, organization_id, role_code, scope_type, granted_by)
    values (u_med_a, org_a, 'WORKER', 'SELF', u_adm_a);
    raise exception 'A4 GAGAL: role WORKER tanpa Worker diterima';
  exception when check_violation then null;
  end;
  checks := checks + 1;

  set local role app_authenticated;

  -- A5 app.my_worker_id: pekerja mendapat Worker miliknya, pengguna kantor mendapat NULL
  perform set_config('app.user_id', u_wrk_a::text, true);
  v := app.my_worker_id();
  if v is distinct from w_a then raise exception 'A5 GAGAL: my_worker_id pekerja = %, seharusnya %', v, w_a; end if;
  perform set_config('app.user_id', u_adm_a::text, true);
  if app.my_worker_id() is not null then raise exception 'A5 GAGAL: pengguna kantor mendapat Worker'; end if;
  checks := checks + 2;

  -- A6 v_user_worker tunduk pada RLS worker: admin A tidak melihat tautan organisasi B
  select count(*) into n from v_user_worker where organization_id <> org_a;
  if n <> 0 then raise exception 'A6 GAGAL: v_user_worker memperlihatkan % tautan organisasi lain', n; end if;
  select count(*) into n from v_user_worker;
  if n = 0 then raise exception 'A6 GAGAL: admin A tidak melihat tautan organisasinya sendiri'; end if;
  checks := checks + 2;

  -- A7 pekerja (scope SELF, LIMITED/SELF ditolak bawaan) tidak membaca baris Worker lain lewat view
  perform set_config('app.user_id', u_wrk_a::text, true);
  select count(*) into n from v_user_worker where user_id <> u_wrk_a;
  if n <> 0 then raise exception 'A7 GAGAL: pekerja melihat tautan akun lain'; end if;
  checks := checks + 1;

  raise notice 'LULUS: % pemeriksaan identitas', checks;
end
$test$;

rollback;

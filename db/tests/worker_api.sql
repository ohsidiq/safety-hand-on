-- worker_api.sql: uji migrasi 0012 (API-003 §2-§3, §7; PB-009 worker.read S; AUD-003).
-- Prasyarat: migrasi diterapkan dan seed kecil dimuat. Semua perubahan dibatalkan.
\set ON_ERROR_STOP on

begin;

do $test$
declare
  org_a uuid; u_wrk uuid; u_mgr uuid; u_adm uuid; w_self uuid; w_other uuid; v int; n bigint; ok boolean; checks int := 0;
begin
  select id into org_a from organization order by name limit 1;
  select id into u_wrk from user_profile where organization_id = org_a and email like 'pekerja1@%';
  select id into u_mgr from user_profile where organization_id = org_a and email like 'hsemgr@%';
  select id into u_adm from user_profile where organization_id = org_a and email like 'admin@%';
  select id into w_self from worker where user_id = u_wrk;
  select id into w_other from worker where organization_id = org_a and id <> w_self and worker_status = 'ACTIVE' limit 1;

  -- A1 has_national_id mengikuti hash, dapat dibaca aplikasi; kolom NIK tetap tertutup
  update worker set national_id_encrypted = '\x01', national_id_hash = '\xbb' where id = w_other;
  if not (select has_national_id from worker where id = w_other) then raise exception 'A1 GAGAL: has_national_id tidak mengikuti hash'; end if;
  if not has_column_privilege('app_authenticated', 'worker', 'has_national_id', 'select')
     or has_column_privilege('app_authenticated', 'worker', 'national_id_hash', 'select') then
    raise exception 'A1 GAGAL: hak kolom NIK salah';
  end if;
  checks := checks + 2;

  -- A2 version pekerja naik satu per perubahan, tidak dapat disetel bebas
  select version into v from worker where id = w_other;
  update worker set full_name = full_name || ' X', version = 77 where id = w_other;
  if (select version from worker where id = w_other) <> v + 1 then raise exception 'A2 GAGAL: version pekerja tidak naik satu'; end if;
  checks := checks + 1;

  -- A3 pekerja melihat dirinya sendiri saja (PB-009 S), dan penempatannya
  set local role app_authenticated;
  perform set_config('app.user_id', u_wrk::text, true);
  select count(*) into n from worker;
  if n <> 1 or not exists (select 1 from worker where id = w_self) then raise exception 'A3 GAGAL: pekerja melihat % baris', n; end if;
  if not exists (select 1 from worker_assignment where worker_id = w_self) then raise exception 'A3 GAGAL: penempatan diri tidak terlihat'; end if;
  if exists (select 1 from worker_assignment where worker_id <> w_self) then raise exception 'A3 GAGAL: penempatan orang lain terlihat'; end if;
  -- tidak dapat mengubah dirinya lewat tabel (ubah data diri lewat endpoint khusus nanti)
  update worker set full_name = 'Ubah Sendiri' where id = w_self;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'A3 GAGAL: pekerja dapat mengubah barisnya'; end if;
  -- pemeriksaan duplikat: ya/tidak tanpa data, dalam organisasi sendiri
  perform set_config('app.user_id', u_mgr::text, true);
  select app.employee_number_exists((select employee_number from worker where id = w_other)) into ok;
  if not ok or app.employee_number_exists('TIDAK-ADA-999') then raise exception 'A3 GAGAL: employee_number_exists salah'; end if;
  reset role;
  -- akun nonaktif tidak lagi terhubung ke pekerja
  update user_profile set status = 'DEACTIVATED' where id = u_wrk;
  set local role app_authenticated;
  perform set_config('app.user_id', u_wrk::text, true);
  if app.my_worker_id() is not null then raise exception 'A3 GAGAL: akun nonaktif masih terhubung'; end if;
  reset role;
  checks := checks + 6;

  -- A4 audit aksi status memuat alasan dan permission worker.deactivate; NIK hanya nama field
  perform set_config('app.user_id', u_adm::text, true);
  perform set_config('app.change_reason', 'Skorsing uji', true);
  update worker set worker_status = 'SUSPENDED' where id = w_other;
  if not exists (select 1 from audit_outbox where payload->>'entity_id' = w_other::text and payload->>'action' = 'worker.suspend'
                 and payload->'changes'->>'reason' = 'Skorsing uji') then
    raise exception 'A4 GAGAL: alasan skorsing tidak tercatat';
  end if;
  if exists (select 1 from audit_outbox where payload::text like '%has_national_id%') then
    raise exception 'A4 GAGAL: kolom turunan NIK tercatat';
  end if;
  checks := checks + 2;

  raise notice 'LULUS: % pemeriksaan API pekerja', checks;
end
$test$;

rollback;

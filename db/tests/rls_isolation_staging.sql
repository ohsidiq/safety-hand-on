-- rls_isolation_staging.sql: uji isolasi tenant (S-4) untuk dijalankan di Supabase SQL Editor.
-- Sama dengan db/tests/rls_isolation.sql, ditambah T9 (anon/authenticated tanpa hak, ARCH-001).
-- Selalu berakhir dengan pesan galat agar semua perubahan uji dibatalkan:
--   "HASIL_UJI LULUS: N pemeriksaan, 0 kebocoran"  -> LULUS
--   pesan berawalan "T1 GAGAL" .. "T9 GAGAL"        -> ada kebocoran, laporkan
-- Prasyarat: migrasi 0001..0004 dan seed sintetis (minimal 2 organisasi).

do $test$
declare
  org_a uuid; org_b uuid;
  u_mgr_a uuid; u_spv_a uuid; u_med_a uuid; u_mgr_b uuid; u_adm_a uuid;
  site_a1 uuid; site_b1 uuid;
  t record; n bigint; rc bigint; checks int := 0;
begin
  select id into org_a from organization order by name limit 1;
  select id into org_b from organization order by name offset 1 limit 1;
  select u.id into u_mgr_a from app_user u where organization_id = org_a and email like 'hsemgr@%';
  select u.id into u_med_a from app_user u where organization_id = org_a and email like 'medis@%';
  select u.id into u_mgr_b from app_user u where organization_id = org_b and email like 'hsemgr@%';
  select u.id into u_spv_a from app_user u where organization_id = org_a and email like 'spv1@%';
  select u.id into u_adm_a from app_user u where organization_id = org_a and email like 'admin@%';
  select ura.site_id into site_a1 from user_role_assignment ura where ura.user_id = u_spv_a;
  select id into site_b1 from site where organization_id = org_b order by name limit 1;

  -- T1 meta: setiap tabel ber-organization_id wajib RLS aktif, dipaksa, dan punya kebijakan
  for t in
    select c.relname, c.relrowsecurity, c.relforcerowsecurity,
           (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relkind = 'r'
      and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped)
  loop
    if not t.relrowsecurity or not t.relforcerowsecurity or t.policies = 0 then
      raise exception 'T1 GAGAL: tabel % tanpa RLS aktif/dipaksa/kebijakan (rls=%, force=%, kebijakan=%)',
        t.relname, t.relrowsecurity, t.relforcerowsecurity, t.policies;
    end if;
    checks := checks + 1;
  end loop;

  -- T9 (khusus Supabase, ARCH-001): peran klien anon/authenticated tidak punya hak atas tabel aplikasi
  if exists (select 1 from pg_roles where rolname = 'anon') then
    for t in
      select c.oid, c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
      where ns.nspname = 'public' and c.relkind = 'r'
    loop
      if has_table_privilege('anon', t.oid, 'select,insert,update,delete')
         or has_table_privilege('authenticated', t.oid, 'select,insert,update,delete') then
        raise exception 'T9 GAGAL: peran klien Supabase punya hak atas %', t.relname;
      end if;
      checks := checks + 1;
    end loop;
  end if;

  set local role app_authenticated;

  -- T2 baca lintas tenant: pengguna org A tidak melihat satu baris pun milik org B
  perform set_config('app.user_id', u_mgr_a::text, true);
  for t in
    select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relkind = 'r'
      and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped)
      and has_table_privilege('app_authenticated', c.oid, 'select')
  loop
    execute format('select count(*) from %I where organization_id <> $1', t.relname) into n using org_a;
    if n <> 0 then raise exception 'T2 GAGAL: % memperlihatkan % baris organisasi lain', t.relname, n; end if;
    checks := checks + 1;
  end loop;
  select count(*) into n from organization where id <> org_a;
  if n <> 0 then raise exception 'T2 GAGAL: organization memperlihatkan organisasi lain'; end if;
  -- dan pengguna A memang melihat datanya sendiri
  select count(*) into n from worker;
  if n = 0 then raise exception 'T2 GAGAL: pengguna A tidak melihat data sendiri'; end if;

  -- T3 tulis lintas tenant: Admin org A (berhak mengelola pekerja) tetap tidak boleh menulis ke org B
  perform set_config('app.user_id', u_adm_a::text, true);
  begin
    insert into worker(organization_id, site_id, full_name, job_position, employment_status)
    values (org_b, site_b1, 'Penyusup', 'Helper', 'EMPLOYEE');
    raise exception 'T3 GAGAL: insert lintas tenant berhasil';
  exception when insufficient_privilege then null;
  end;
  -- kontrol positif: admin A boleh menulis ke org A
  insert into worker(organization_id, site_id, full_name, job_position, employment_status)
  select org_a, id, 'Pekerja Baru', 'Helper', 'EMPLOYEE' from site where organization_id = org_a order by name limit 1;
  get diagnostics rc = row_count;
  if rc <> 1 then raise exception 'T3 GAGAL: admin tidak dapat menulis ke organisasinya sendiri'; end if;
  update worker set full_name = 'Diubah' where organization_id = org_b;
  get diagnostics rc = row_count;
  if rc <> 0 then raise exception 'T3 GAGAL: update lintas tenant mengubah % baris', rc; end if;
  delete from worker where organization_id = org_b;
  get diagnostics rc = row_count;
  if rc <> 0 then raise exception 'T3 GAGAL: delete lintas tenant menghapus % baris', rc; end if;
  begin
    insert into outbox_event(organization_id, event_type) values (org_b, 'PENYUSUP');
    raise exception 'T3 GAGAL: outbox lintas tenant berhasil';
  exception when insufficient_privilege then null;
  end;
  checks := checks + 5;

  -- T4 cakupan Site: Supervisor Site 1 hanya melihat pekerja Site 1
  perform set_config('app.user_id', u_spv_a::text, true);
  select count(*) into n from worker where site_id <> site_a1;
  if n <> 0 then raise exception 'T4 GAGAL: Supervisor melihat % pekerja Site lain', n; end if;
  select count(*) into n from worker;
  if n = 0 then raise exception 'T4 GAGAL: Supervisor tidak melihat pekerja Site-nya'; end if;
  select count(*) into n from competency_record where site_id <> site_a1;
  if n <> 0 then raise exception 'T4 GAGAL: Supervisor melihat kompetensi Site lain'; end if;
  checks := checks + 3;

  -- T5 pemisahan Medical: Supervisor tanpa status, HSE Manager hanya status, detail hanya peran Medical
  select count(*) into n from medical_status;
  if n <> 0 then raise exception 'T5 GAGAL: Supervisor melihat status Medical'; end if;
  perform set_config('app.user_id', u_mgr_a::text, true);
  select count(*) into n from medical_status;
  if n = 0 then raise exception 'T5 GAGAL: HSE Manager tidak melihat status Medical'; end if;
  select count(*) into n from medical_detail;
  if n <> 0 then raise exception 'T5 GAGAL: HSE Manager melihat detail Medical'; end if;
  perform set_config('app.user_id', u_med_a::text, true);
  select count(*) into n from medical_detail;
  if n = 0 then raise exception 'T5 GAGAL: peran Medical tidak melihat detail'; end if;
  select count(*) into n from medical_detail where organization_id <> org_a;
  if n <> 0 then raise exception 'T5 GAGAL: detail Medical lintas tenant'; end if;
  checks := checks + 5;

  -- T6 tanpa pengguna (anonim): tidak melihat apa pun
  perform set_config('app.user_id', '', true);
  for t in
    select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relkind = 'r'
      and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped)
      and has_table_privilege('app_authenticated', c.oid, 'select')
  loop
    execute format('select count(*) from %I', t.relname) into n;
    if n <> 0 then raise exception 'T6 GAGAL: anonim melihat % baris di %', n, t.relname; end if;
    checks := checks + 1;
  end loop;

  reset role;

  -- T7 integritas FK komposit: pekerja tidak boleh menunjuk Site organisasi lain
  begin
    insert into worker(organization_id, site_id, full_name, job_position, employment_status)
    select org_a, id, 'Salah', 'Helper', 'EMPLOYEE' from site where organization_id = org_b limit 1;
    raise exception 'T7 GAGAL: FK komposit tidak mencegah Site lintas organisasi';
  exception when foreign_key_violation then null;
  end;

  -- T8 audit append-only
  insert into audit_log(organization_id, action, entity) values (org_a, 'UJI', 'rls');
  begin
    update audit_log set action = 'UBAH' where organization_id = org_a;
    raise exception 'T8 GAGAL: audit_log dapat diubah';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from audit_log where organization_id = org_a;
    raise exception 'T8 GAGAL: audit_log dapat dihapus';
  exception when insufficient_privilege then null;
  end;
  begin
    truncate audit_log;
    raise exception 'T8 GAGAL: audit_log dapat dikosongkan';
  exception when insufficient_privilege then null;
  end;
  checks := checks + 4;

  -- Diakhiri dengan exception agar seluruh perubahan uji dibatalkan (staging tetap bersih).
  raise exception 'HASIL_UJI LULUS: % pemeriksaan, 0 kebocoran (perubahan uji dibatalkan)', checks;
end
$test$;

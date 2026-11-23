-- 0013: Isolasi antar-kontraktor (M2.5)
-- Sumber: SRS-PPL003 FR-PPL003-003, AC-PPL003-002/003, BR-PPL003-005; DB-002 AR-012; DB-008 RLS-007; B-23, B-26.
-- Peran CONTRACTOR_ADMIN tetap tidak aktif dan tanpa permission sampai P2 (ROLE_NOT_ACTIVE). Migrasi ini menyiapkan
-- jalur scope CONTRACTOR di RLS sejak P0 agar isolasi teruji otomatis setiap rilis (SRS-PPL003 §9).
-- Data sintetis saja (B-24).

-- ---------------------------------------------------------------- 1. kontraktor dalam scope pemanggil
create function app.permitted_contractors(perm text) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct ura.scope_id), '{}'::uuid[])
  from user_role_assignment ura
  join role_permission rp on rp.role_code = ura.role_code
  join user_profile up on up.id = ura.user_id and up.status = 'ACTIVE'
  where ura.user_id = app.current_user_id()
    and ura.scope_type = 'CONTRACTOR'
    and ura.revoked_at is null and ura.valid_from <= now() and (ura.valid_until is null or ura.valid_until > now())
    and rp.permission_code = perm and rp.constraint_level in ('FULL', 'TEAM')
$$;
revoke execute on function app.permitted_contractors(text) from public;
grant execute on function app.permitted_contractors(text) to app_authenticated;

-- ---------------------------------------------------------------- 2. pekerja dan penempatan: scope CONTRACTOR hanya pekerja kontraktornya
-- Pekerja non-kontraktor (contractor_id NULL) tidak pernah cocok (AC-PPL003-003).
drop policy worker_read on worker;
create policy worker_read on worker for select to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('worker.read'))
              or site_id = any ((select app.permitted_sites('worker.read'))::uuid[])
              or id = any ((select app.permitted_team_workers('worker.read'))::uuid[])
              or contractor_id = any ((select app.permitted_contractors('worker.read'))::uuid[])));

drop policy worker_assignment_read on worker_assignment;
create policy worker_assignment_read on worker_assignment for select to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('worker.read'))
              or site_id = any ((select app.permitted_sites('worker.read'))::uuid[])
              or worker_id = any ((select app.permitted_team_workers('worker.read'))::uuid[])
              or worker_id in (select w.id from worker w
                               where w.contractor_id = any ((select app.permitted_contractors('worker.read'))::uuid[]))));

-- ---------------------------------------------------------------- 3. data induk kontraktor: pengguna kontraktor hanya kontraktornya
-- Staf perusahaan (scope organisasi atau Site) melihat semua kontraktor organisasinya untuk pemilih (B-23).
-- Scope CONTRACTOR tidak lagi melihat kontraktor lain (sebelumnya has_any_scope membuka semua).
create function app.staff_scope(perm text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.has_org_wide(perm) or cardinality(app.permitted_sites(perm)) > 0
$$;
revoke execute on function app.staff_scope(text) from public;
grant execute on function app.staff_scope(text) to app_authenticated;

drop policy contractor_read on contractor;
create policy contractor_read on contractor for select to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.staff_scope('contractor.read'))
              or id = any ((select app.permitted_contractors('contractor.read'))::uuid[])));

drop policy contractor_site_read on contractor_site;
create policy contractor_site_read on contractor_site for select to app_authenticated
  using (organization_id = (select app.current_org())
         and ((select app.staff_scope('contractor.read'))
              or contractor_id = any ((select app.permitted_contractors('contractor.read'))::uuid[])));

drop policy contractor_insert on contractor;
create policy contractor_insert on contractor for insert to app_authenticated
  with check (organization_id = (select app.current_org()) and (select app.staff_scope('contractor.manage')));
drop policy contractor_update on contractor;
create policy contractor_update on contractor for update to app_authenticated
  using (organization_id = (select app.current_org()) and (select app.staff_scope('contractor.manage')))
  with check (organization_id = (select app.current_org()));
drop policy contractor_site_insert on contractor_site;
create policy contractor_site_insert on contractor_site for insert to app_authenticated
  with check (organization_id = (select app.current_org()) and (select app.staff_scope('contractor.manage')));
drop policy contractor_site_update on contractor_site;
create policy contractor_site_update on contractor_site for update to app_authenticated
  using (organization_id = (select app.current_org()) and (select app.staff_scope('contractor.manage')))
  with check (organization_id = (select app.current_org()));

-- 0012: Dukungan API Pekerja (M2.4)
-- Sumber: API-003 §2-§4, §8 (WF-API-005/006/010), API-000 §10, PB-009 (worker.read SELF), AUD-003.
-- Data sintetis saja (B-24).

-- ---------------------------------------------------------------- 1. has_national_id tanpa membuka NIK
-- Peran aplikasi tidak dapat membaca kolom NIK (0010). Respons API hanya memuat has_national_id (API-003 §2).
alter table worker add column has_national_id boolean generated always as (national_id_hash is not null) stored;
grant select (has_national_id) on worker to app_authenticated;

-- ---------------------------------------------------------------- 2. version pekerja dinaikkan pemicu (If-Match)
create trigger worker_version before update on worker for each row execute function app.bump_version();

-- ---------------------------------------------------------------- 3. pekerja melihat data dirinya (PB-009 worker.read S, WF-API-010)
-- Berlaku untuk akun ACTIVE yang terhubung ke Worker (B-18), apa pun perannya. Ubah data diri menyusul lewat endpoint khusus.
create or replace function app.my_worker_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select w.id from worker w
  join user_profile up on up.id = w.user_id and up.organization_id = w.organization_id and up.status = 'ACTIVE'
  where w.user_id = app.current_user_id()
$$;
create policy worker_self_read on worker for select to app_authenticated
  using (id = (select app.my_worker_id()));
create policy worker_assignment_self_read on worker_assignment for select to app_authenticated
  using (worker_id = (select app.my_worker_id()));

-- ---------------------------------------------------------------- 4. audit pekerja: alasan aksi status, permission yang tepat
-- Alasan dikirim Core API lewat GUC transaksi app.change_reason (tidak disimpan di baris worker).
-- Semua aksi status memakai permission worker.deactivate (API-003 §3).
create or replace function app.audit_worker_change() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_new jsonb := to_jsonb(new) - 'national_id_encrypted' - 'national_id_hash' - 'has_national_id' - 'updated_at' - 'version';
  v_old jsonb := case when tg_op = 'UPDATE' then
    to_jsonb(old) - 'national_id_encrypted' - 'national_id_hash' - 'has_national_id' - 'updated_at' - 'version' end;
  v_fields text[];
  v_changes jsonb;
  v_action text;
  v_reason text := left(nullif(current_setting('app.change_reason', true), ''), 500);
begin
  if tg_table_name = 'worker_assignment' then
    if new.reason = 'INITIAL' then
      return null; -- penempatan awal sudah tercakup worker.create
    end if;
    perform app.audit_enqueue(new.organization_id, 'worker.assign', 'worker', new.worker_id,
      array['site_id', 'department_id', 'division_id', 'job_position_id', 'effective_from', 'reason'],
      jsonb_build_object('site_id', new.site_id, 'department_id', new.department_id, 'division_id', new.division_id,
                         'job_position_id', new.job_position_id, 'effective_from', new.effective_from, 'reason', new.reason),
      'worker.update', new.site_id);
    return null;
  end if;
  if tg_op = 'INSERT' then
    select array_agg(k order by k) into v_fields from jsonb_object_keys(v_new) k where k not in ('id', 'organization_id', 'created_at');
    if new.national_id_hash is not null then v_fields := array_append(v_fields, 'national_id'); end if;
    perform app.audit_enqueue(new.organization_id, 'worker.create', 'worker', new.id, v_fields,
      v_new - 'id' - 'organization_id' - 'created_at', 'worker.create', new.site_id);
    return null;
  end if;
  select array_agg(k order by k), jsonb_object_agg(k, jsonb_build_object('from', v_old->k, 'to', v_new->k))
  into v_fields, v_changes
  from jsonb_object_keys(v_new) k where v_new->k is distinct from v_old->k;
  if new.national_id_hash is distinct from old.national_id_hash then
    v_fields := array_append(coalesce(v_fields, '{}'::text[]), 'national_id');
  end if;
  if v_fields is null then
    return null;
  end if;
  v_action := case
    when new.worker_status is distinct from old.worker_status then
      case new.worker_status when 'SUSPENDED' then 'worker.suspend' when 'INACTIVE' then 'worker.deactivate'
        when 'RESIGNED' then 'worker.resign' else case old.worker_status when 'SUSPENDED' then 'worker.reinstate' else 'worker.reactivate' end end
    else 'worker.update' end;
  if v_action <> 'worker.update' and v_reason is not null then
    v_changes := coalesce(v_changes, '{}'::jsonb) || jsonb_build_object('reason', v_reason);
  end if;
  perform app.audit_enqueue(new.organization_id, v_action, 'worker', new.id, v_fields, v_changes,
    case when v_action = 'worker.update' then 'worker.update' else 'worker.deactivate' end, new.site_id);
  return null;
end $$;
revoke execute on function app.audit_worker_change() from public;

-- ---------------------------------------------------------------- 5. pemeriksaan duplikat nomor pekerja (API-003 §7)
-- Hanya ya/tidak dalam organisasi pemanggil, tanpa data pekerja; tidak bergantung scope Site pemanggil.
create function app.employee_number_exists(p_number text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from worker
                 where organization_id = app.current_org() and deleted_at is null and employee_number = p_number)
$$;
revoke execute on function app.employee_number_exists(text) from public;
grant execute on function app.employee_number_exists(text) to app_authenticated;

-- 0021_medical_master_delete.sql: hapus master Medical yang belum pernah dipakai (keputusan pemilik 2026-11-27, B-28).
-- Berlaku untuk medical_exam_type dan medical_clearance_type saja. Master yang sudah dirujuk record MCU atau pemeriksaan
-- kesiapan TIDAK dapat dihapus (kunci asing menolak; API menjawab 409 MASTER_IN_USE) dan tetap dinonaktifkan seperti
-- sebelumnya, sehingga riwayat tetap utuh (ORG-API-003 tetap berlaku untuk master lain). Penghapusan tercatat di audit.

create function app.audit_master_delete() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old jsonb := to_jsonb(old) - 'organization_id' - 'created_at' - 'updated_at';
begin
  perform app.audit_enqueue(old.organization_id, tg_argv[0] || '.delete', tg_table_name, old.id,
    array(select k from jsonb_object_keys(v_old) k order by k), v_old, tg_argv[1], null);
  return null;
end $$;
revoke execute on function app.audit_master_delete() from public;

grant delete on medical_exam_type to app_authenticated;
create policy medical_exam_type_delete on medical_exam_type for delete to app_authenticated
  using (organization_id = (select app.current_org()) and (select app.has_org_wide('readiness_profile.manage')));
create trigger audit_medical_exam_type_delete after delete on medical_exam_type
  for each row execute function app.audit_master_delete('medical_exam_type', 'readiness_profile.manage');

grant delete on medical_clearance_type to app_authenticated;
create policy medical_clearance_type_delete on medical_clearance_type for delete to app_authenticated
  using (organization_id = (select app.current_org()) and (select app.has_org_wide('readiness_profile.manage')));
create trigger audit_medical_clearance_type_delete after delete on medical_clearance_type
  for each row execute function app.audit_master_delete('medical_clearance_type', 'readiness_profile.manage');

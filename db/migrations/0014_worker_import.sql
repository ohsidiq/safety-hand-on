-- 0014: Impor pekerja (M2.5)
-- Sumber: API-003 §6 (impor, dry_run, all_or_nothing, galat per baris), API-000 §11 (Idempotency-Key), WF-API-011, AUD.
-- Penyimpangan tercatat: impor P0 menerima isi CSV pada badan permintaan dan diproses sinkron (maks 1.000 baris) karena
-- alur file (API-000 §14) dan job asinkron belum dibangun. NIK pada file tidak pernah disimpan di tabel ini.
-- Data sintetis saja (B-24).

create table worker_import (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organization (id),
  idempotency_key  uuid not null,
  request_hash     text not null,
  all_or_nothing   boolean not null,
  status           text not null check (status in ('COMPLETED', 'REJECTED')),
  total_rows       integer not null check (total_rows >= 0),
  created_count    integer not null check (created_count >= 0),
  failed_count     integer not null check (failed_count >= 0),
  -- galat per baris: nomor baris, field, kode. Tanpa nilai sel (tidak ada NIK atau data pribadi).
  errors           jsonb not null default '[]',
  created_by       uuid not null references user_profile (id),
  created_at       timestamptz not null default now(),
  unique (organization_id, idempotency_key)
);
create index worker_import_org_created_idx on worker_import (organization_id, created_at desc);

alter table worker_import enable row level security;
alter table worker_import force row level security;
revoke all on worker_import from public;
grant select, insert on worker_import to app_authenticated;
create policy worker_import_read on worker_import for select to app_authenticated
  using (organization_id = (select app.current_org())
         and (created_by = (select app.current_user_id()) or (select app.has_org_wide('worker.create'))));
create policy worker_import_insert on worker_import for insert to app_authenticated
  with check (organization_id = (select app.current_org()) and created_by = (select app.current_user_id())
              and (select app.has_any_scope('worker.create')));

-- ringkasan impor tercatat sekali (worker.import); setiap pekerja yang dibuat tetap tercatat worker.create
create function app.audit_worker_import() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.audit_enqueue(new.organization_id, 'worker.import', 'worker_import', new.id,
    array['status', 'total_rows', 'created_count', 'failed_count', 'all_or_nothing'],
    jsonb_build_object('status', new.status, 'total_rows', new.total_rows, 'created_count', new.created_count,
                       'failed_count', new.failed_count, 'all_or_nothing', new.all_or_nothing),
    'worker.create', null);
  return null;
end $$;
revoke execute on function app.audit_worker_import() from public;
create trigger audit_worker_import after insert on worker_import for each row execute function app.audit_worker_import();

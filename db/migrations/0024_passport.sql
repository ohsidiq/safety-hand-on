-- 0024_passport.sql: M4.3 QR Safety Passport (API-014 bagian 7, FR-RE-013, RDY-API-006/007, B-30).
-- QR memuat token acak berumur pendek (5 menit), bukan SHO ID atau identitas mentah. Hanya hash SHA-256 token yang
-- disimpan, sehingga isi tabel tidak dapat dipakai untuk memalsukan QR. Tanpa rahasia penandatanganan di server
-- aplikasi: keabsahan dicek dengan mencocokkan hash di database (dapat dicabut, tercatat).
-- Pemindaian membutuhkan pemindai terautentikasi dengan readiness.read atas pekerja itu (organisasi, Site, atau tim)
-- dan dicatat di audit. Respons pemindaian minimal: nama, jabatan, Site, status, kategori syarat (ok/peringatan) tanpa
-- detail medis, NIK, atau nomor dokumen.

create table passport_token (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organization (id),
  worker_id        uuid not null references worker (id),
  token_hash       bytea not null unique,
  issued_by        uuid references user_profile (id),
  issued_at        timestamptz not null default now(),
  expires_at       timestamptz not null,
  constraint passport_token_ttl_chk check (expires_at > issued_at and expires_at <= issued_at + interval '10 minutes')
);
create index passport_token_worker_idx on passport_token (worker_id, expires_at);
create index passport_token_expiry_idx on passport_token (expires_at);

alter table passport_token enable row level security;
alter table passport_token force row level security;
revoke all on passport_token from public;
-- hanya fungsi SECURITY DEFINER milik pemilik migrasi yang membaca/menulis (pola 0008/0023)
create policy passport_token_definer on passport_token for all to current_user using (true) with check (true);

-- apakah pemanggil dapat membaca kesiapan pekerja ini (organisasi, Site, tim; opsional diri sendiri)
create function app.can_read_readiness(p_worker uuid, p_site uuid, p_allow_self boolean) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.has_org_wide('readiness.read')
      or p_site = any (app.permitted_sites('readiness.read'))
      or p_worker = any (app.permitted_team_workers('readiness.read'))
      or (p_allow_self and p_worker = app.my_worker_id() and app.has_self_permission('readiness.read'))
$$;
revoke execute on function app.can_read_readiness(uuid, uuid, boolean) from public;

-- Menerbitkan token QR (FR-RE-013). Pekerja untuk dirinya sendiri atau peran yang berwenang atas pekerja itu.
create function app.passport_issue(p_worker uuid, out token text, out expires_at timestamptz)
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  w record;
begin
  select id, organization_id, site_id, worker_status, deleted_at into w
    from worker where id = p_worker and organization_id = app.current_org();
  if w.id is null or not app.can_read_readiness(w.id, w.site_id, true) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if w.worker_status <> 'ACTIVE' or w.deleted_at is not null then
    raise exception 'WORKER_INACTIVE: pekerja tidak aktif' using errcode = '23514';
  end if;
  -- 2 x UUID v4 acak = 244 bit acak
  token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  expires_at := now() + interval '5 minutes';
  insert into passport_token (organization_id, worker_id, token_hash, issued_by, expires_at)
  values (w.organization_id, w.id, sha256(convert_to(token, 'UTF8')), app.current_user_id(), expires_at);
  -- kebersihan: token kedaluwarsa lebih dari sehari dihapus
  delete from passport_token pt where pt.expires_at < now() - interval '1 day';
end $$;
revoke execute on function app.passport_issue(uuid) from public;
grant execute on function app.passport_issue(uuid) to app_authenticated;

-- Memverifikasi token hasil pindai (RDY-API-007). Token tidak dikenal atau kedaluwarsa -> 401; pekerja di luar scope
-- pemindai atau organisasi lain -> NOT_FOUND. Setiap pemindaian yang berhasil dicatat di audit.
create function app.passport_verify(p_token text)
returns table (worker_id uuid, full_name text, job_position text, site text, status text, categories jsonb,
               evaluated_at timestamptz)
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  t passport_token%rowtype;
  w record;
  rc record;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'PASSPORT_TOKEN_INVALID' using errcode = '28000';
  end if;
  select * into t from passport_token pt where pt.token_hash = sha256(convert_to(p_token, 'UTF8'));
  if t.id is null then
    raise exception 'PASSPORT_TOKEN_INVALID' using errcode = '28000';
  end if;
  if t.expires_at <= now() then
    raise exception 'PASSPORT_TOKEN_EXPIRED' using errcode = '28000';
  end if;
  select wk.id, wk.organization_id, wk.site_id, wk.full_name, jp.name as job_position, s.name as site_name into w
    from worker wk left join job_position jp on jp.id = wk.job_position_id left join site s on s.id = wk.site_id
   where wk.id = t.worker_id;
  if w.organization_id is distinct from app.current_org() or not app.can_read_readiness(w.id, w.site_id, false) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  select c.snapshot_id, c.status, c.evaluated_at into rc from readiness_current c where c.worker_id = w.id;
  perform app.audit_enqueue(w.organization_id, 'passport.scan', 'worker', w.id, array['readiness'],
    jsonb_build_object('status', rc.status, 'snapshot_id', rc.snapshot_id), 'readiness.read', w.site_id);
  return query
    select w.id, w.full_name, w.job_position, w.site_name, rc.status,
           coalesce((
             select jsonb_agg(jsonb_build_object(
                      'item_type', g.item_type,
                      'ok', g.ok,
                      'warning', g.warning) order by g.ord)
               from (
                 select i.item_type,
                        min(case i.item_type when 'COMPETENCY' then 1 when 'MEDICAL' then 2 when 'AUTHORIZATION' then 3 else 4 end) as ord,
                        bool_and(not i.is_mandatory or i.requirement_status in ('VALID', 'EXPIRING_SOON', 'RESTRICTED')) as ok,
                        case when bool_or(i.requirement_status = 'RESTRICTED') then 'RESTRICTED'
                             when bool_or(i.requirement_status = 'EXPIRING_SOON') then 'EXPIRING_SOON' end as warning
                   from readiness_snapshot_item i where i.snapshot_id = rc.snapshot_id
                  group by i.item_type
               ) g), '[]'::jsonb),
           rc.evaluated_at;
end $$;
revoke execute on function app.passport_verify(text) from public;
grant execute on function app.passport_verify(text) to app_authenticated;

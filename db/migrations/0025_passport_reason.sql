-- 0025_passport_reason.sql: hasil pindai QR Safety Passport menjelaskan alasan status (permintaan pemilik 2026-11-28,
-- tambahan B-30). Ditambahkan:
-- - reason_code snapshot (WORKER_INACTIVE / PROFILE_NOT_SET), agar "Tidak siap" tanpa daftar syarat dapat dijelaskan;
-- - per kategori: jumlah syarat wajib yang belum terpenuhi (unmet) dan jumlah syarat (total).
-- Tetap minimal (FR-RE-013): tanpa nama syarat medis, tanggal, hasil pemeriksaan, NIK, atau nomor dokumen. Untuk
-- kategori non-medis, nama syarat yang belum terpenuhi disertakan (unmet_names) agar pemindai tahu apa yang kurang;
-- kategori MEDICAL tidak pernah menyertakan nama (hanya jumlah), sesuai penyamaran SRS-RE 10.

drop function app.passport_verify(text);

create function app.passport_verify(p_token text)
returns table (worker_id uuid, full_name text, job_position text, site text, status text, reason_code text,
               categories jsonb, evaluated_at timestamptz)
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
  select c.snapshot_id, c.status, c.evaluated_at, rs.reason_code into rc
    from readiness_current c join readiness_snapshot rs on rs.id = c.snapshot_id where c.worker_id = w.id;
  perform app.audit_enqueue(w.organization_id, 'passport.scan', 'worker', w.id, array['readiness'],
    jsonb_build_object('status', rc.status, 'snapshot_id', rc.snapshot_id), 'readiness.read', w.site_id);
  return query
    select w.id, w.full_name, w.job_position, w.site_name, rc.status, rc.reason_code,
           coalesce((
             select jsonb_agg(jsonb_build_object(
                      'item_type', g.item_type,
                      'ok', g.unmet = 0,
                      'warning', g.warning,
                      'unmet', g.unmet,
                      'total', g.total,
                      'unmet_names', case when g.item_type = 'MEDICAL' then '[]'::jsonb else g.unmet_names end)
                    order by g.ord)
               from (
                 select i.item_type,
                        min(case i.item_type when 'COMPETENCY' then 1 when 'MEDICAL' then 2 when 'AUTHORIZATION' then 3 else 4 end) as ord,
                        count(*) filter (where i.is_mandatory
                                           and i.requirement_status not in ('VALID', 'EXPIRING_SOON', 'RESTRICTED'))::int as unmet,
                        count(*)::int as total,
                        coalesce(jsonb_agg(i.item_name order by i.item_name)
                                   filter (where i.is_mandatory
                                             and i.requirement_status not in ('VALID', 'EXPIRING_SOON', 'RESTRICTED')),
                                 '[]'::jsonb) as unmet_names,
                        case when bool_or(i.requirement_status = 'RESTRICTED') then 'RESTRICTED'
                             when bool_or(i.requirement_status = 'EXPIRING_SOON') then 'EXPIRING_SOON' end as warning
                   from readiness_snapshot_item i where i.snapshot_id = rc.snapshot_id
                  group by i.item_type
               ) g), '[]'::jsonb),
           rc.evaluated_at;
end $$;
revoke execute on function app.passport_verify(text) from public;
grant execute on function app.passport_verify(text) to app_authenticated;

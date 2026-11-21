-- Prototipe spike S-2: evaluasi kesiapan massal, set-based, deterministik.
-- BUKAN implementasi SRS-RE. Menguji bentuk biaya algoritma (join syarat x bukti x medical)
-- pada data sintetis. Aturan yang dimodelkan:
--   NOT_READY    : ada syarat wajib tanpa bukti terverifikasi, bukti kedaluwarsa, atau Medical tidak FIT/kosong/kedaluwarsa
--   CONDITIONAL  : semua syarat terpenuhi tetapi ada yang segera berakhir (<= warning_days)
--   READY        : selainnya
-- Kedaluwarsa dihitung sampai akhir hari menurut zona waktu Site, tanpa toleransi (SH-03).
create or replace function app.evaluate_readiness(p_worker_ids uuid[]) returns int
language plpgsql as $$
declare n int;
begin
  with w as (
    select w.id, w.organization_id, w.site_id, w.job_position,
           (now() at time zone s.timezone)::date as today
    from worker w join site s on s.id = w.site_id
    where w.id = any (p_worker_ids)
  ),
  req as (
    select w.id as worker_id, ri.requirement_name, ri.warning_days, w.today,
           (select max(c.expires_on) from competency_record c
             where c.worker_id = w.id and c.requirement_name = ri.requirement_name
               and c.verified_at is not null) as best_exp
    from w join requirement_item ri
      on ri.organization_id = w.organization_id and ri.job_position = w.job_position
  ),
  req_state as (
    select worker_id, requirement_name,
           case when best_exp is null then 'MISSING'
                when best_exp < today then 'EXPIRED'
                when best_exp <= today + warning_days then 'EXPIRING'
                else 'OK' end as st
    from req
  ),
  req_agg as (
    select worker_id,
           bool_or(st in ('MISSING','EXPIRED')) as blocked,
           bool_or(st = 'EXPIRING') as warn,
           coalesce(jsonb_agg(jsonb_build_object('requirement', requirement_name, 'state', st))
                    filter (where st <> 'OK'), '[]'::jsonb) as reasons
    from req_state group by worker_id
  ),
  med as (
    select w.id as worker_id,
           (m.worker_id is null or m.status <> 'FIT' or m.expires_on < w.today) as blocked
    from w left join medical_status m on m.worker_id = w.id
  ),
  result as (
    select w.id as worker_id, w.organization_id, w.site_id,
           case when coalesce(ra.blocked, true) or md.blocked then 'NOT_READY'
                when ra.warn then 'CONDITIONAL'
                else 'READY' end as status,
           coalesce(ra.reasons, '[]'::jsonb)
             || case when md.blocked then jsonb_build_array(jsonb_build_object('requirement','Medical','state','NOT_MET'))
                     else '[]'::jsonb end as reasons
    from w left join req_agg ra on ra.worker_id = w.id
           join med md on md.worker_id = w.id
  ),
  up as (
    insert into readiness_snapshot(worker_id, organization_id, site_id, status, reasons, evaluated_at)
    select worker_id, organization_id, site_id, status, reasons, now() from result
    on conflict (worker_id) do update
      set status = excluded.status, reasons = excluded.reasons, evaluated_at = excluded.evaluated_at
    returning 1
  )
  select count(*) into n from up;
  return n;
end $$;

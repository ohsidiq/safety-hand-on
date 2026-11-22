-- synthetic_seed.sql: data sintetis deterministik (B-24: tidak ada data nyata).
-- Pemakaian:
--   psql -v n_orgs=20 -v n_workers=1000 -v n_sites=5 -v prefix=Demo -f db/seed/synthetic_seed.sql
-- Setiap organisasi mendapat: Site, pengguna per peran, syarat per posisi, pekerja,
-- catatan kompetensi dan Medical dengan campuran valid, segera berakhir, kedaluwarsa, dan kosong.
\set ON_ERROR_STOP on
\if :{?n_orgs} \else \set n_orgs 2 \endif
\if :{?n_workers} \else \set n_workers 50 \endif
\if :{?n_sites} \else \set n_sites 3 \endif
\if :{?prefix} \else \set prefix Org \endif

create schema if not exists seed;

create or replace function seed.make_org(p_name text, p_sites int, p_workers int) returns uuid
language plpgsql set search_path = public, pg_temp as $$
declare
  v_org uuid;
  v_req text[] := array['K3 Umum','Induksi Site','Sertifikat Posisi','Otorisasi Kerja'];
  v_pos text[] := array['Operator Alat Berat','Welder','Helper'];
begin
  insert into organization(name) values (p_name) returning id into v_org;

  insert into site(organization_id, name)
  select v_org, 'Site ' || g from generate_series(1, p_sites) g;

  -- pengguna tingkat organisasi
  insert into app_user(organization_id, email)
  select v_org, r || '@' || replace(lower(p_name), ' ', '-') || '.contoh'
  from unnest(array['admin','hsemgr','medis']) r;
  insert into user_role_assignment(user_id, organization_id, role_code, site_id)
  select u.id, v_org,
         case split_part(u.email, '@', 1) when 'admin' then 'ORG_ADMIN' when 'hsemgr' then 'HSE_MANAGER' else 'MEDICAL_REVIEWER' end,
         null
  from app_user u where u.organization_id = v_org;

  -- pengguna per Site
  insert into app_user(organization_id, email)
  select v_org, r || s.n || '@' || replace(lower(p_name), ' ', '-') || '.contoh'
  from (select row_number() over (order by name) n from site where organization_id = v_org) s,
       unnest(array['spv','hseo']) r;
  insert into user_role_assignment(user_id, organization_id, role_code, site_id)
  select u.id, v_org,
         case when u.email like 'spv%' then 'SUPERVISOR' else 'HSE_OFFICER' end,
         (select id from (select id, row_number() over (order by name) n from site where organization_id = v_org) x
           where x.n = substring(split_part(u.email, '@', 1) from '\d+')::int)
  from app_user u
  where u.organization_id = v_org and (u.email like 'spv%' or u.email like 'hseo%');

  insert into requirement_item(organization_id, job_position, requirement_name)
  select v_org, p, r from unnest(v_pos) p, unnest(v_req) r;

  insert into worker(organization_id, site_id, full_name, job_position, employment_status)
  select v_org,
         (select id from (select id, row_number() over (order by name) n from site where organization_id = v_org) x
           where x.n = 1 + (g % p_sites)),
         'Pekerja ' || lpad(g::text, 6, '0'),
         v_pos[1 + (g % 3)],
         case when g % 10 < 3 then 'CONTRACTOR' else 'EMPLOYEE' end
  from generate_series(1, p_workers) g;

  -- kompetensi: ~5% kosong, ~10% kedaluwarsa, ~15% segera berakhir (<30 hari), sisanya valid
  insert into competency_record(organization_id, site_id, worker_id, requirement_name, expires_on, verified_at)
  select w.organization_id, w.site_id, w.id, r.name,
         case when x.p < 0.15 then current_date - (1 + floor(random() * 60))::int
              when x.p < 0.30 then current_date + (1 + floor(random() * 28))::int
              else current_date + (31 + floor(random() * 360))::int end,
         case when random() < 0.95 then now() else null end
  from worker w
  cross join unnest(v_req) as r(name)
  cross join lateral (select random() as p) x
  where w.organization_id = v_org and random() >= 0.05;

  insert into medical_status(worker_id, organization_id, site_id, status, expires_on)
  select w.id, w.organization_id, w.site_id,
         case when random() < 0.97 then 'FIT' else 'UNFIT' end,
         case when random() < 0.08 then current_date - (1 + floor(random() * 30))::int
              else current_date + (30 + floor(random() * 330))::int end
  from worker w where w.organization_id = v_org;

  insert into medical_detail(worker_id, organization_id, site_id, detail)
  select w.id, w.organization_id, w.site_id, 'Catatan medis sintetis ' || w.full_name
  from worker w where w.organization_id = v_org;

  return v_org;
end $$;

select setseed(0.42);
select seed.make_org(:'prefix' || ' ' || g, :n_sites, :n_workers) from generate_series(1, :n_orgs) g;
analyze;
select count(*) as organisasi from organization \gset
select count(*) as pekerja from worker \gset
select :organisasi as organisasi, :pekerja as pekerja;

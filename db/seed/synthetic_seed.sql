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
  v_admin uuid;
  v_req text[] := array['K3 Umum','Induksi Site','Sertifikat Posisi','Otorisasi Kerja'];
  v_pos text[] := array['Operator Alat Berat','Welder','Helper'];
begin
  insert into organization(name, code) values (p_name, upper(regexp_replace(p_name, '[^A-Za-z0-9]', '', 'g')))
  returning id into v_org;

  insert into site(organization_id, name, code, location, timezone)
  select v_org, 'Site ' || g, 'SITE-' || g, 'Lokasi sintetis ' || g,
         (array['Asia/Makassar', 'Asia/Jakarta', 'Asia/Jayapura'])[1 + ((g - 1) % 3)]
  from generate_series(1, p_sites) g;

  -- struktur organisasi sintetis (M2.1): department dan team per Site, posisi dan kelas alat tingkat organisasi,
  -- satu kontraktor yang terhubung ke Site 1 (B-23)
  insert into department(organization_id, site_id, name, code)
  select v_org, s.id, d.name, d.code
  from site s, (values ('Produksi', 'PROD'), ('Pemeliharaan', 'MAINT')) d(name, code)
  where s.organization_id = v_org;
  insert into team(organization_id, site_id, department_id, name, code)
  select v_org, d.site_id, d.id, 'Tim ' || d.name, 'TIM-' || d.code
  from department d where d.organization_id = v_org;
  insert into job_position(organization_id, name, code, job_family)
  select v_org, p.name, p.code, p.family
  from (values ('Operator Alat Berat', 'OPR-AB', 'Operator'), ('Welder', 'WELDER', 'Mekanik'), ('Helper', 'HELPER', 'Umum')) p(name, code, family);
  insert into equipment_class(organization_id, name, code)
  select v_org, e.name, e.code
  from (values ('Dump Truck', 'DT'), ('Excavator', 'EXC'), ('Light Vehicle', 'LV')) e(name, code);
  -- dua kontraktor sintetis (FR-PPL003-004): A terhubung Site 1, B terhubung Site 2
  insert into contractor(organization_id, name, code, contract_start, contract_end)
  values (v_org, 'Kontraktor Sintetis A', 'KTR-A', current_date - 180, current_date + 185),
         (v_org, 'Kontraktor Sintetis B', 'KTR-B', current_date - 90, current_date + 275);
  insert into contractor_site(organization_id, contractor_id, site_id, valid_from)
  select v_org, c.id, s.id, current_date - 180
  from contractor c, site s
  where c.organization_id = v_org and s.organization_id = v_org
    and ((c.code = 'KTR-A' and s.code = 'SITE-1') or (c.code = 'KTR-B' and s.code = 'SITE-2'));

  -- pengguna tingkat organisasi (nama sintetis). Company Admin pertama dibuat sistem (granted_by NULL);
  -- penugasan lain diberikan oleh Company Admin.
  insert into user_profile(organization_id, email, full_name, status)
  select v_org, r || '@' || replace(lower(p_name), ' ', '-') || '.contoh', initcap(r) || ' ' || p_name, 'ACTIVE'
  from unnest(array['admin','hsemgr','medis']) r;
  select id into v_admin from user_profile where organization_id = v_org and email like 'admin@%';
  insert into user_role_assignment(user_id, organization_id, role_code, scope_type, scope_id, granted_by)
  select u.id, v_org,
         case split_part(u.email, '@', 1) when 'admin' then 'COMPANY_ADMIN' when 'hsemgr' then 'HSE_MANAGER' else 'MEDICAL_OFFICER' end,
         'ORGANIZATION', null,
         case when u.id = v_admin then null else v_admin end
  from user_profile u where u.organization_id = v_org;

  -- pengguna per Site
  insert into user_profile(organization_id, email, full_name, status)
  select v_org, r || s.n || '@' || replace(lower(p_name), ' ', '-') || '.contoh', initcap(r) || ' ' || s.n || ' ' || p_name, 'ACTIVE'
  from (select row_number() over (order by name) n from site where organization_id = v_org) s,
       unnest(array['spv','hseo']) r;
  insert into user_role_assignment(user_id, organization_id, role_code, scope_type, scope_id, granted_by)
  select u.id, v_org,
         case when u.email like 'spv%' then 'SUPERVISOR' else 'HSE_OFFICER' end,
         'SITE',
         (select id from (select id, row_number() over (order by name) n from site where organization_id = v_org) x
           where x.n = substring(split_part(u.email, '@', 1) from '\d+')::int),
         v_admin
  from user_profile u
  where u.organization_id = v_org and (u.email like 'spv%' or u.email like 'hseo%');

  insert into requirement_item(organization_id, job_position, requirement_name)
  select v_org, p, r from unnest(v_pos) p, unnest(v_req) r;

  -- pekerja: ~30% Site 1 berstatus CONTRACTOR (kontraktor A, terhubung Site 1), ~10% Site 2 kontraktor B
  -- (terhubung Site 2, ER-012/ER-013), sebagian CONTRACT, sisanya PERMANENT. SHO ID dibuat trigger.
  insert into worker(organization_id, site_id, full_name, employee_number, employment_status, contractor_id, join_date,
                     department_id, job_position_id)
  select v_org, s.id, 'Pekerja ' || lpad(g::text, 6, '0'), 'EMP-' || lpad(g::text, 6, '0'),
         case when s.code = 'SITE-1' and g % 10 < 3 then 'CONTRACTOR' when s.code = 'SITE-2' and g % 10 = 0 then 'CONTRACTOR'
              when g % 10 < 3 then 'CONTRACT' else 'PERMANENT' end,
         case when s.code = 'SITE-1' and g % 10 < 3 then (select id from contractor where organization_id = v_org and code = 'KTR-A')
              when s.code = 'SITE-2' and g % 10 = 0 then (select id from contractor where organization_id = v_org and code = 'KTR-B') end,
         current_date - (30 + g % 700),
         (select id from department where site_id = s.id and code = case when g % 4 = 0 then 'MAINT' else 'PROD' end),
         (select id from job_position where organization_id = v_org and name = v_pos[1 + (g % 3)])
  from generate_series(1, p_workers) g
  join lateral (select id, code from (select id, code, row_number() over (order by name) n from site where organization_id = v_org) x
                where x.n = 1 + (g % p_sites)) s on true;

  -- keanggotaan team: setiap pekerja masuk team department-nya
  insert into team_member(organization_id, team_id, worker_id, valid_from)
  select v_org, t.id, w.id, w.join_date
  from worker w join team t on t.department_id = w.department_id
  where w.organization_id = v_org;

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

  -- satu akun pekerja lapangan sintetis (role WORKER, scope SELF) yang terhubung lewat worker.user_id (B-18)
  insert into user_profile(organization_id, email, full_name, status)
  values (v_org, 'pekerja1@' || replace(lower(p_name), ' ', '-') || '.contoh', 'Pekerja 000001', 'ACTIVE');
  update worker set user_id = (select id from user_profile where organization_id = v_org and email like 'pekerja1@%')
  where id = (select id from worker where organization_id = v_org and full_name = 'Pekerja 000001');
  insert into user_role_assignment(user_id, organization_id, role_code, scope_type, scope_id, granted_by)
  select id, v_org, 'WORKER', 'SELF', null, v_admin from user_profile where organization_id = v_org and email like 'pekerja1@%';

  -- Supervisor berscope Tim (PB-008): team Produksi Site 1
  insert into user_profile(organization_id, email, full_name, status)
  values (v_org, 'spvtim1@' || replace(lower(p_name), ' ', '-') || '.contoh', 'Spv Tim 1 ' || p_name, 'ACTIVE');
  insert into user_role_assignment(user_id, organization_id, role_code, scope_type, scope_id, granted_by)
  select u.id, v_org, 'SUPERVISOR', 'TEAM', (select t.id from team t join site s on s.id = t.site_id
                                            where s.organization_id = v_org and s.code = 'SITE-1' and t.code = 'TIM-PROD'), v_admin
  from user_profile u where u.organization_id = v_org and u.email like 'spvtim1@%';

  -- master kompetensi sintetis (WF003) dan kompetensi pekerja: dibuat HSE Officer Site, sebagian diverifikasi
  -- HSE Manager (pemisahan tugas, B-05), sebagian menunggu, sebagian kedaluwarsa atau segera berakhir
  insert into competency(organization_id, name, code, description, default_validity_months)
  values (v_org, 'K3 Umum', 'CMP-K3-UMUM', 'Kompetensi keselamatan umum (sintetis)', 36),
         (v_org, 'Operator Alat Berat', 'CMP-OPR-AB', 'Sertifikat operator alat berat (sintetis)', 36),
         (v_org, 'Pengelasan', 'CMP-LAS', 'Sertifikat juru las (sintetis)', 24);
  insert into worker_competency(organization_id, site_id, worker_id, competency_id, valid_from, valid_until, source,
                                verification_status, verified_by, verified_at, created_by)
  select w.organization_id, w.site_id, w.id, c.id, x.vf, x.vf + 730,
         'CERTIFICATE',
         case when x.p < 0.20 then 'PENDING' else 'VERIFIED' end,
         case when x.p < 0.20 then null else (select id from user_profile where organization_id = v_org and email like 'hsemgr@%') end,
         case when x.p < 0.20 then null else now() end,
         (select u.id from user_profile u where u.organization_id = v_org and u.email like 'hseo1@%')
  from worker w
  join competency c on c.organization_id = v_org and c.code = 'CMP-K3-UMUM'
  cross join lateral (select random() as p,
                             current_date - 730 + (case when random() < 0.15 then -(1 + floor(random() * 60))::int
                                                        when random() < 0.30 then (1 + floor(random() * 28))::int
                                                        else (31 + floor(random() * 300))::int end) as vf
                      where w.id is not null) x  -- merujuk w: acak per baris, bukan sekali untuk semua
  where w.organization_id = v_org and w.site_id = (select id from site where organization_id = v_org and code = 'SITE-1');

  -- jenis Otorisasi Kerja sintetis (WF005, bukan Permit To Work) dan otorisasi pekerja Site 1:
  -- sebagian menunggu, sebagian terverifikasi, satu dibekukan HSE Manager
  insert into authorization_type(organization_id, name, code, description, requires_work_scope, default_validity_months)
  values (v_org, 'Kerja di Ketinggian', 'AUTH-HEIGHT', 'Bekerja di atas 2 meter (sintetis)', false, 24),
         (v_org, 'Ruang Terbatas', 'AUTH-CONFINED', 'Masuk ruang terbatas (sintetis)', false, 12),
         (v_org, 'Pekerjaan Panas', 'AUTH-HOTWORK', 'Pengelasan dan pemotongan (sintetis)', true, 12);
  insert into worker_authorization(organization_id, site_id, worker_id, authorization_type_id, authorization_number, valid_from,
                                   valid_until, verification_status, verified_by, verified_at, created_by)
  select w.organization_id, w.site_id, w.id, t.id, 'KT-SINTETIS-' || w.sho_id, x.vf, x.vf + 730,
         case when x.p < 0.25 then 'PENDING' else 'VERIFIED' end,
         case when x.p < 0.25 then null else (select id from user_profile where organization_id = v_org and email like 'hsemgr@%') end,
         case when x.p < 0.25 then null else now() end,
         (select u.id from user_profile u where u.organization_id = v_org and u.email like 'hseo1@%')
  from worker w
  join authorization_type t on t.organization_id = v_org and t.code = 'AUTH-HEIGHT'
  cross join lateral (select random() as p,
                             current_date - 730 + (case when random() < 0.15 then -(1 + floor(random() * 60))::int
                                                        when random() < 0.30 then (1 + floor(random() * 28))::int
                                                        else (31 + floor(random() * 300))::int end) as vf
                      where w.id is not null) x
  where w.organization_id = v_org and w.site_id = (select id from site where organization_id = v_org and code = 'SITE-1')
    and random() < 0.6;
  update worker_authorization set suspension_status = 'SUSPENDED', suspension_reason = 'Pemeriksaan ulang (sintetis)',
         suspended_at = now(), suspended_by = (select id from user_profile where organization_id = v_org and email like 'hsemgr@%')
   where id = (select id from worker_authorization where organization_id = v_org and verification_status = 'VERIFIED'
               order by worker_id limit 1);

  -- SIMPER sintetis (WF006): jenis, SIMPER pekerja Site 1 (sebagian), otorisasi per kelas alat dalam masa berlaku induk
  insert into simper_type(organization_id, name, code, description, default_validity_months)
  values (v_org, 'SIMPER Unit Produksi', 'SIMPER-PROD', 'Izin mengoperasikan alat produksi (sintetis)', 12),
         (v_org, 'SIMPER Kendaraan Ringan', 'SIMPER-LV', 'Izin mengemudikan kendaraan ringan (sintetis)', 24);
  insert into simper(organization_id, site_id, worker_id, simper_type_id, simper_number, valid_from, valid_until,
                     verification_status, verified_by, verified_at, created_by)
  select w.organization_id, w.site_id, w.id, t.id, 'SMP-SINTETIS-' || w.sho_id, x.vf, x.vf + 365,
         case when x.p < 0.25 then 'PENDING' else 'VERIFIED' end,
         case when x.p < 0.25 then null else (select id from user_profile where organization_id = v_org and email like 'hsemgr@%') end,
         case when x.p < 0.25 then null else now() end,
         (select u.id from user_profile u where u.organization_id = v_org and u.email like 'hseo1@%')
  from worker w
  join simper_type t on t.organization_id = v_org and t.code = 'SIMPER-PROD'
  cross join lateral (select random() as p,
                             current_date - 365 + (case when random() < 0.15 then -(1 + floor(random() * 30))::int
                                                        when random() < 0.30 then (1 + floor(random() * 28))::int
                                                        else (31 + floor(random() * 200))::int end) as vf
                      where w.id is not null) x
  where w.organization_id = v_org and w.site_id = (select id from site where organization_id = v_org and code = 'SITE-1')
    and random() < 0.5;
  -- kelas alat: Dump Truck untuk semua; Excavator untuk sebagian. Otorisasi dibuat sebelum status induk akhir agar
  -- pemicu (induk kembali PENDING) tidak mengubah status hasil seed
  create temp table _seed_simper_status on commit drop as
    select id, verification_status, verified_by, verified_at from simper where organization_id = v_org;
  insert into simper_authorization(organization_id, simper_id, equipment_class_id, valid_from, valid_until, created_by)
  select s.organization_id, s.id, c.id, s.valid_from, s.valid_until, s.created_by
  from simper s join equipment_class c on c.organization_id = v_org and c.code = 'DT' where s.organization_id = v_org;
  insert into simper_authorization(organization_id, simper_id, equipment_class_id, valid_from, valid_until, restriction_note, created_by)
  select s.organization_id, s.id, c.id, s.valid_from, s.valid_until, 'Hanya siang hari (sintetis)', s.created_by
  from simper s join equipment_class c on c.organization_id = v_org and c.code = 'EXC'
  where s.organization_id = v_org and s.id in (select id from simper where organization_id = v_org order by worker_id limit 3);
  update simper s set verification_status = t.verification_status, verified_by = t.verified_by, verified_at = t.verified_at
    from _seed_simper_status t where t.id = s.id and t.verification_status <> 'PENDING';
  drop table _seed_simper_status;

  -- Medical sintetis (WF004): TANPA diagnosis. Dicatat HSE Officer (administratif), ditetapkan Medical Officer.
  -- Sebaran: sebagian besar FIT, beberapa FIT_WITH_RESTRICTION (pembatasan operasional), satu TEMPORARILY_UNFIT,
  -- satu UNFIT, sebagian belum ditetapkan.
  insert into medical_exam_type(organization_id, name, code, default_validity_months)
  values (v_org, 'MCU Awal', 'MCU-PRE', 12), (v_org, 'MCU Berkala', 'MCU-PERIODIC', 12);
  insert into medical_record(organization_id, site_id, worker_id, exam_type_id, examination_date, expiry_date, provider, created_by)
  select w.organization_id, w.site_id, w.id, t.id, x.ed, x.ed + 365, 'Klinik Sintetis Sejahtera',
         (select u.id from user_profile u where u.organization_id = v_org and u.email like 'hseo1@%')
  from worker w
  join medical_exam_type t on t.organization_id = v_org and t.code = 'MCU-PERIODIC'
  cross join lateral (select current_date - 365 + (case when random() < 0.15 then -(1 + floor(random() * 30))::int
                                                        when random() < 0.30 then (1 + floor(random() * 28))::int
                                                        else (31 + floor(random() * 200))::int end) as ed
                      where w.id is not null) x
  where w.organization_id = v_org and w.site_id = (select id from site where organization_id = v_org and code = 'SITE-1');
  with ranked as (
    select m.id, row_number() over (order by m.worker_id) as rn, count(*) over () as n from medical_record m where m.organization_id = v_org
  )
  update medical_record m set
    verification_status = 'VERIFIED', verified_at = now(),
    verified_by = (select id from user_profile where organization_id = v_org and email like 'medis@%'),
    fitness_status = case when r.rn = 1 then 'UNFIT' when r.rn = 2 then 'TEMPORARILY_UNFIT'
                          when r.rn in (3, 4) then 'FIT_WITH_RESTRICTION' else 'FIT' end,
    unfit_until = case when r.rn = 2 then current_date + 30 end
  from ranked r where r.id = m.id and r.rn <= r.n - 2;  -- dua terakhir belum ditetapkan
  insert into medical_restriction(organization_id, medical_record_id, restriction_code, operational_description, valid_from,
                                  valid_until, created_by)
  select m.organization_id, m.id, 'NO_WORK_AT_HEIGHT', 'Tidak bekerja di ketinggian di atas 2 meter', m.examination_date,
         m.examination_date + 180, m.verified_by
  from medical_record m where m.organization_id = v_org and m.fitness_status = 'FIT_WITH_RESTRICTION';

  return v_org;
end $$;

select setseed(0.42);
select seed.make_org(:'prefix' || ' ' || g, :n_sites, :n_workers) from generate_series(1, :n_orgs) g;
analyze;
select count(*) as organisasi from organization \gset
select count(*) as pekerja from worker \gset
select :organisasi as organisasi, :pekerja as pekerja;

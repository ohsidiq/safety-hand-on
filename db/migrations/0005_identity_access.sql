-- 0005_identity_access.sql
-- M1.1: identitas dan akses sesuai DB-002 v2.4.1, PB-008 v3.5, PB-009 v3.5 (SRS-PLT01).
-- Menggantikan katalog ilustrasi M0 (0002) dengan katalog resmi. Katalog role/permission/role_permission
-- dibangkitkan dari packages/rbac/permission-matrix.json; uji integrasi memastikan database sama dengan berkas itu.
--
-- Keputusan implementasi (dapat diubah pemilik):
-- * user_profile.id = auth.users.id di Supabase. FK ke auth.users sengaja tidak dibuat agar migrasi portabel
--   (PostgreSQL lokal/CI tidak punya skema auth); keterkaitan diperiksa Core API saat login.
-- * granted_by boleh NULL hanya untuk penugasan yang dibuat sistem (seed/migrasi, mis. Company Admin pertama).
--   Penugasan lewat API wajib granted_by (ditegakkan Core API, M1.2).
-- * Scope Supervisor "Tim/Department/Area" memakai SITE sampai tabel department dan tim ada (M2).
-- * RLS hanya menghormati level FULL dan TEAM (dalam scope penugasan). LIMITED dan SELF ditolak secara bawaan
--   (BR-PLT01-001) sampai aturan khususnya dibangun: SELF butuh worker.user_id (B-18, M2), LIMITED butuh
--   aturan per catatan PB-009 (mis. HSE Manager medical.read_detail hanya dengan otorisasi tercatat).

-- ---------------------------------------------------------------- katalog role dan permission
alter table role
  add column if not exists name text,
  add column if not exists scope_levels text[] not null default '{}',
  add column if not exists phase text,
  add column if not exists is_active boolean not null default true;

alter table permission
  add column if not exists module text,
  add column if not exists action text,
  add column if not exists domain text,
  add column if not exists description text,
  add column if not exists is_sensitive boolean not null default false;

alter table role_permission
  add column if not exists constraint_level text not null default 'FULL';
alter table role_permission
  add constraint role_permission_constraint_level_chk check (constraint_level in ('FULL', 'LIMITED', 'TEAM', 'SELF'));

insert into role(code, name, scope_levels, phase, is_active) values
  ('PLATFORM_SUPER_ADMIN', 'Platform Super Admin', array['PLATFORM']::text[], 'P0', true),
  ('COMPANY_ADMIN', 'Company Admin', array['ORGANIZATION']::text[], 'P0', true),
  ('EXECUTIVE', 'Executive', array['ORGANIZATION', 'SITE']::text[], 'P1', true),
  ('HSE_MANAGER', 'HSE Manager', array['ORGANIZATION', 'SITE']::text[], 'P1', true),
  ('HSE_OFFICER', 'HSE Officer', array['SITE']::text[], 'P1', true),
  ('SITE_ADMIN', 'Site Admin', array['SITE']::text[], 'P0', true),
  ('SUPERVISOR', 'Supervisor', array['SITE', 'DEPARTMENT', 'TEAM']::text[], 'P1', true),
  ('MEDICAL_OFFICER', 'Medical Officer', array['ORGANIZATION', 'SITE']::text[], 'P1', true),
  ('TRAINER', 'Trainer', array['ORGANIZATION', 'SITE']::text[], 'P3', false),
  ('AUDITOR', 'Auditor', array['ORGANIZATION']::text[], 'P2', false),
  ('WORKER', 'Worker', array['SELF']::text[], 'P0', true),
  ('CONTRACTOR_ADMIN', 'Contractor Admin', array['CONTRACTOR']::text[], 'P2', false)
on conflict (code) do update set name = excluded.name, scope_levels = excluded.scope_levels,
  phase = excluded.phase, is_active = excluded.is_active;

insert into permission(code, module, action, domain, description, is_sensitive) values
  ('tenant.manage', 'tenant', 'manage', 'People', 'Mengelola tenant', false),
  ('organization.read', 'organization', 'read', 'People', 'Melihat struktur organisasi', false),
  ('organization.manage', 'organization', 'manage', 'People', 'Mengelola organisasi, site, department, Job Position', false),
  ('worker.read', 'worker', 'read', 'People', 'Melihat data pekerja', false),
  ('worker.create', 'worker', 'create', 'People', 'Menambah pekerja', false),
  ('worker.update', 'worker', 'update', 'People', 'Mengubah data pekerja', false),
  ('worker.deactivate', 'worker', 'deactivate', 'People', 'Menonaktifkan pekerja', false),
  ('user.manage', 'user', 'manage', 'People', 'Mengelola pengguna', false),
  ('role.manage', 'role', 'manage', 'People', 'Menugaskan role dan scope', false),
  ('contractor.read', 'contractor', 'read', 'People', 'Melihat data kontraktor (P2)', false),
  ('contractor.manage', 'contractor', 'manage', 'People', 'Mengelola kontraktor dan keterkaitan Site (P2)', false),
  ('contractor_document.update', 'contractor_document', 'update', 'People', 'Menambah atau mengubah dokumen perusahaan kontraktor (P2)', false),
  ('contractor_document.verify', 'contractor_document', 'verify', 'People', 'Memverifikasi dokumen perusahaan kontraktor (P2)', false),
  ('competency.read', 'competency', 'read', 'Readiness', 'Melihat kompetensi', false),
  ('competency.update', 'competency', 'update', 'Readiness', 'Menambah atau mengubah kompetensi', false),
  ('competency.verify', 'competency', 'verify', 'Readiness', 'Memverifikasi kompetensi', false),
  ('medical.read_status', 'medical', 'read_status', 'Readiness', 'Melihat status Fit to Work, pembatasan, tanggal berakhir', false),
  ('medical.read_detail', 'medical', 'read_detail', 'Readiness', 'Melihat detail hasil medis', true),
  ('medical.update', 'medical', 'update', 'Readiness', 'Mencatat data medical', false),
  ('medical.verify', 'medical', 'verify', 'Readiness', 'Menetapkan Fit to Work', false),
  ('authorization.read', 'authorization', 'read', 'Readiness', 'Melihat Otorisasi Kerja', false),
  ('authorization.update', 'authorization', 'update', 'Readiness', 'Menambah atau mengubah Otorisasi Kerja', false),
  ('authorization.verify', 'authorization', 'verify', 'Readiness', 'Memverifikasi Otorisasi Kerja', false),
  ('simper.read', 'simper', 'read', 'Readiness', 'Melihat SIMPER', false),
  ('simper.update', 'simper', 'update', 'Readiness', 'Menambah atau mengubah SIMPER', false),
  ('simper.verify', 'simper', 'verify', 'Readiness', 'Memverifikasi SIMPER', false),
  ('training.read', 'training', 'read', 'Readiness', 'Melihat training', false),
  ('training.manage', 'training', 'manage', 'Readiness', 'Mengelola training dan kehadiran', false),
  ('readiness.read', 'readiness', 'read', 'Readiness', 'Melihat status kesiapan dan alasan', false),
  ('readiness.evaluate', 'readiness', 'evaluate', 'Readiness', 'Menjalankan evaluasi ulang manual', false),
  ('readiness_profile.manage', 'readiness_profile', 'manage', 'Readiness', 'Mengelola Requirement Profile', false),
  ('inspection.read', 'inspection', 'read', 'Operations', 'Melihat inspeksi', false),
  ('inspection.create', 'inspection', 'create', 'Operations', 'Menjadwalkan inspeksi', false),
  ('inspection.execute', 'inspection', 'execute', 'Operations', 'Melaksanakan inspeksi yang ditugaskan', false),
  ('inspection.review', 'inspection', 'review', 'Operations', 'Meninjau hasil inspeksi', false),
  ('observation.create', 'observation', 'create', 'Operations', 'Membuat observasi', false),
  ('observation.read', 'observation', 'read', 'Operations', 'Melihat observasi', false),
  ('observation.review', 'observation', 'review', 'Operations', 'Meninjau observasi', false),
  ('corrective_action.read', 'corrective_action', 'read', 'Operations', 'Melihat Corrective Action', false),
  ('corrective_action.create', 'corrective_action', 'create', 'Operations', 'Membuat Corrective Action', false),
  ('corrective_action.assign', 'corrective_action', 'assign', 'Operations', 'Menugaskan PIC', false),
  ('corrective_action.update', 'corrective_action', 'update', 'Operations', 'Memperbarui progres tugas', false),
  ('corrective_action.verify', 'corrective_action', 'verify', 'Operations', 'Memverifikasi penyelesaian', false),
  ('dashboard.view', 'dashboard', 'view', 'Intelligence', 'Melihat dashboard', false),
  ('compliance.view', 'compliance', 'view', 'Intelligence', 'Melihat dashboard kepatuhan', false),
  ('report.export', 'report', 'export', 'Intelligence', 'Mengekspor laporan', false),
  ('ai_recommendation.read', 'ai_recommendation', 'read', 'Intelligence', 'Melihat rekomendasi AI', false),
  ('ai_recommendation.generate', 'ai_recommendation', 'generate', 'Intelligence', 'Membuat rekomendasi AI', false),
  ('ai_recommendation.review', 'ai_recommendation', 'review', 'Intelligence', 'Meninjau, menerima, atau menolak rekomendasi', false),
  ('ai_recommendation.configure', 'ai_recommendation', 'configure', 'Intelligence', 'Mengatur AI perusahaan', false),
  ('notification.read', 'notification', 'read', 'Platform', 'Melihat notifikasi sendiri', false),
  ('notification.configure', 'notification', 'configure', 'Platform', 'Mengatur notifikasi perusahaan', false),
  ('audit.view', 'audit', 'view', 'Platform', 'Melihat jejak audit', false),
  ('configuration.manage', 'configuration', 'manage', 'Platform', 'Konfigurasi tenant', false),
  ('platform.configure', 'platform', 'configure', 'Platform', 'Konfigurasi platform', false),
  ('integration.manage', 'integration', 'manage', 'Platform', 'Mengelola integrasi (P5)', false)
on conflict (code) do update set module = excluded.module, action = excluded.action, domain = excluded.domain,
  description = excluded.description, is_sensitive = excluded.is_sensitive;

-- Peran ilustrasi M0 dipetakan ke katalog resmi
update user_role_assignment set role_code = 'COMPANY_ADMIN' where role_code = 'ORG_ADMIN';
update user_role_assignment set role_code = 'MEDICAL_OFFICER' where role_code = 'MEDICAL_REVIEWER';

delete from role_permission;
delete from permission where code not in ('tenant.manage', 'organization.read', 'organization.manage', 'worker.read', 'worker.create', 'worker.update', 'worker.deactivate', 'user.manage', 'role.manage', 'contractor.read', 'contractor.manage', 'contractor_document.update', 'contractor_document.verify', 'competency.read', 'competency.update', 'competency.verify', 'medical.read_status', 'medical.read_detail', 'medical.update', 'medical.verify', 'authorization.read', 'authorization.update', 'authorization.verify', 'simper.read', 'simper.update', 'simper.verify', 'training.read', 'training.manage', 'readiness.read', 'readiness.evaluate', 'readiness_profile.manage', 'inspection.read', 'inspection.create', 'inspection.execute', 'inspection.review', 'observation.create', 'observation.read', 'observation.review', 'corrective_action.read', 'corrective_action.create', 'corrective_action.assign', 'corrective_action.update', 'corrective_action.verify', 'dashboard.view', 'compliance.view', 'report.export', 'ai_recommendation.read', 'ai_recommendation.generate', 'ai_recommendation.review', 'ai_recommendation.configure', 'notification.read', 'notification.configure', 'audit.view', 'configuration.manage', 'platform.configure', 'integration.manage');
delete from role where code not in ('PLATFORM_SUPER_ADMIN', 'COMPANY_ADMIN', 'EXECUTIVE', 'HSE_MANAGER', 'HSE_OFFICER', 'SITE_ADMIN', 'SUPERVISOR', 'MEDICAL_OFFICER', 'TRAINER', 'AUDITOR', 'WORKER', 'CONTRACTOR_ADMIN');

insert into role_permission(role_code, permission_code, constraint_level) values
  ('PLATFORM_SUPER_ADMIN', 'tenant.manage', 'FULL'),
  ('COMPANY_ADMIN', 'organization.read', 'FULL'),
  ('EXECUTIVE', 'organization.read', 'FULL'),
  ('HSE_MANAGER', 'organization.read', 'FULL'),
  ('HSE_OFFICER', 'organization.read', 'FULL'),
  ('SITE_ADMIN', 'organization.read', 'FULL'),
  ('SUPERVISOR', 'organization.read', 'FULL'),
  ('MEDICAL_OFFICER', 'organization.read', 'FULL'),
  ('TRAINER', 'organization.read', 'FULL'),
  ('AUDITOR', 'organization.read', 'FULL'),
  ('COMPANY_ADMIN', 'organization.manage', 'FULL'),
  ('SITE_ADMIN', 'organization.manage', 'LIMITED'),
  ('COMPANY_ADMIN', 'worker.read', 'FULL'),
  ('HSE_MANAGER', 'worker.read', 'FULL'),
  ('HSE_OFFICER', 'worker.read', 'FULL'),
  ('SITE_ADMIN', 'worker.read', 'FULL'),
  ('SUPERVISOR', 'worker.read', 'TEAM'),
  ('MEDICAL_OFFICER', 'worker.read', 'FULL'),
  ('TRAINER', 'worker.read', 'LIMITED'),
  ('AUDITOR', 'worker.read', 'FULL'),
  ('WORKER', 'worker.read', 'SELF'),
  ('COMPANY_ADMIN', 'worker.create', 'FULL'),
  ('HSE_MANAGER', 'worker.create', 'FULL'),
  ('HSE_OFFICER', 'worker.create', 'FULL'),
  ('SITE_ADMIN', 'worker.create', 'FULL'),
  ('COMPANY_ADMIN', 'worker.update', 'FULL'),
  ('HSE_MANAGER', 'worker.update', 'FULL'),
  ('HSE_OFFICER', 'worker.update', 'FULL'),
  ('SITE_ADMIN', 'worker.update', 'FULL'),
  ('WORKER', 'worker.update', 'SELF'),
  ('COMPANY_ADMIN', 'worker.deactivate', 'FULL'),
  ('HSE_MANAGER', 'worker.deactivate', 'FULL'),
  ('SITE_ADMIN', 'worker.deactivate', 'FULL'),
  ('PLATFORM_SUPER_ADMIN', 'user.manage', 'LIMITED'),
  ('COMPANY_ADMIN', 'user.manage', 'FULL'),
  ('COMPANY_ADMIN', 'role.manage', 'FULL'),
  ('COMPANY_ADMIN', 'contractor.read', 'FULL'),
  ('HSE_MANAGER', 'contractor.read', 'FULL'),
  ('HSE_OFFICER', 'contractor.read', 'FULL'),
  ('SITE_ADMIN', 'contractor.read', 'LIMITED'),
  ('AUDITOR', 'contractor.read', 'FULL'),
  ('COMPANY_ADMIN', 'contractor.manage', 'FULL'),
  ('HSE_MANAGER', 'contractor.manage', 'FULL'),
  ('COMPANY_ADMIN', 'contractor_document.update', 'FULL'),
  ('HSE_MANAGER', 'contractor_document.update', 'FULL'),
  ('HSE_OFFICER', 'contractor_document.update', 'FULL'),
  ('HSE_MANAGER', 'contractor_document.verify', 'FULL'),
  ('HSE_OFFICER', 'contractor_document.verify', 'LIMITED'),
  ('COMPANY_ADMIN', 'competency.read', 'FULL'),
  ('HSE_MANAGER', 'competency.read', 'FULL'),
  ('HSE_OFFICER', 'competency.read', 'FULL'),
  ('SITE_ADMIN', 'competency.read', 'FULL'),
  ('SUPERVISOR', 'competency.read', 'TEAM'),
  ('TRAINER', 'competency.read', 'FULL'),
  ('AUDITOR', 'competency.read', 'FULL'),
  ('WORKER', 'competency.read', 'SELF'),
  ('HSE_MANAGER', 'competency.update', 'FULL'),
  ('HSE_OFFICER', 'competency.update', 'FULL'),
  ('SITE_ADMIN', 'competency.update', 'FULL'),
  ('TRAINER', 'competency.update', 'LIMITED'),
  ('WORKER', 'competency.update', 'SELF'),
  ('HSE_MANAGER', 'competency.verify', 'FULL'),
  ('HSE_OFFICER', 'competency.verify', 'LIMITED'),
  ('COMPANY_ADMIN', 'medical.read_status', 'FULL'),
  ('HSE_MANAGER', 'medical.read_status', 'FULL'),
  ('HSE_OFFICER', 'medical.read_status', 'FULL'),
  ('SITE_ADMIN', 'medical.read_status', 'FULL'),
  ('SUPERVISOR', 'medical.read_status', 'TEAM'),
  ('MEDICAL_OFFICER', 'medical.read_status', 'FULL'),
  ('AUDITOR', 'medical.read_status', 'FULL'),
  ('WORKER', 'medical.read_status', 'SELF'),
  ('HSE_MANAGER', 'medical.read_detail', 'LIMITED'),
  ('MEDICAL_OFFICER', 'medical.read_detail', 'FULL'),
  ('WORKER', 'medical.read_detail', 'SELF'),
  ('HSE_OFFICER', 'medical.update', 'LIMITED'),
  ('SITE_ADMIN', 'medical.update', 'LIMITED'),
  ('MEDICAL_OFFICER', 'medical.update', 'FULL'),
  ('MEDICAL_OFFICER', 'medical.verify', 'FULL'),
  ('COMPANY_ADMIN', 'authorization.read', 'FULL'),
  ('HSE_MANAGER', 'authorization.read', 'FULL'),
  ('HSE_OFFICER', 'authorization.read', 'FULL'),
  ('SITE_ADMIN', 'authorization.read', 'FULL'),
  ('SUPERVISOR', 'authorization.read', 'TEAM'),
  ('AUDITOR', 'authorization.read', 'FULL'),
  ('WORKER', 'authorization.read', 'SELF'),
  ('HSE_MANAGER', 'authorization.update', 'FULL'),
  ('HSE_OFFICER', 'authorization.update', 'FULL'),
  ('SITE_ADMIN', 'authorization.update', 'FULL'),
  ('WORKER', 'authorization.update', 'SELF'),
  ('HSE_MANAGER', 'authorization.verify', 'FULL'),
  ('HSE_OFFICER', 'authorization.verify', 'LIMITED'),
  ('COMPANY_ADMIN', 'simper.read', 'FULL'),
  ('HSE_MANAGER', 'simper.read', 'FULL'),
  ('HSE_OFFICER', 'simper.read', 'FULL'),
  ('SITE_ADMIN', 'simper.read', 'FULL'),
  ('SUPERVISOR', 'simper.read', 'TEAM'),
  ('AUDITOR', 'simper.read', 'FULL'),
  ('WORKER', 'simper.read', 'SELF'),
  ('HSE_MANAGER', 'simper.update', 'FULL'),
  ('HSE_OFFICER', 'simper.update', 'FULL'),
  ('SITE_ADMIN', 'simper.update', 'FULL'),
  ('WORKER', 'simper.update', 'SELF'),
  ('HSE_MANAGER', 'simper.verify', 'FULL'),
  ('HSE_OFFICER', 'simper.verify', 'LIMITED'),
  ('COMPANY_ADMIN', 'training.read', 'FULL'),
  ('HSE_MANAGER', 'training.read', 'FULL'),
  ('HSE_OFFICER', 'training.read', 'FULL'),
  ('SITE_ADMIN', 'training.read', 'FULL'),
  ('SUPERVISOR', 'training.read', 'TEAM'),
  ('TRAINER', 'training.read', 'FULL'),
  ('AUDITOR', 'training.read', 'FULL'),
  ('WORKER', 'training.read', 'SELF'),
  ('HSE_MANAGER', 'training.manage', 'FULL'),
  ('HSE_OFFICER', 'training.manage', 'LIMITED'),
  ('TRAINER', 'training.manage', 'FULL'),
  ('COMPANY_ADMIN', 'readiness.read', 'FULL'),
  ('EXECUTIVE', 'readiness.read', 'LIMITED'),
  ('HSE_MANAGER', 'readiness.read', 'FULL'),
  ('HSE_OFFICER', 'readiness.read', 'FULL'),
  ('SITE_ADMIN', 'readiness.read', 'FULL'),
  ('SUPERVISOR', 'readiness.read', 'TEAM'),
  ('MEDICAL_OFFICER', 'readiness.read', 'FULL'),
  ('AUDITOR', 'readiness.read', 'FULL'),
  ('WORKER', 'readiness.read', 'SELF'),
  ('HSE_MANAGER', 'readiness.evaluate', 'FULL'),
  ('HSE_OFFICER', 'readiness.evaluate', 'FULL'),
  ('SITE_ADMIN', 'readiness.evaluate', 'LIMITED'),
  ('COMPANY_ADMIN', 'readiness_profile.manage', 'FULL'),
  ('HSE_MANAGER', 'readiness_profile.manage', 'FULL'),
  ('COMPANY_ADMIN', 'inspection.read', 'FULL'),
  ('HSE_MANAGER', 'inspection.read', 'FULL'),
  ('HSE_OFFICER', 'inspection.read', 'FULL'),
  ('SITE_ADMIN', 'inspection.read', 'FULL'),
  ('SUPERVISOR', 'inspection.read', 'TEAM'),
  ('AUDITOR', 'inspection.read', 'FULL'),
  ('WORKER', 'inspection.read', 'LIMITED'),
  ('HSE_MANAGER', 'inspection.create', 'FULL'),
  ('HSE_OFFICER', 'inspection.create', 'FULL'),
  ('SUPERVISOR', 'inspection.create', 'LIMITED'),
  ('HSE_MANAGER', 'inspection.execute', 'FULL'),
  ('HSE_OFFICER', 'inspection.execute', 'FULL'),
  ('SUPERVISOR', 'inspection.execute', 'FULL'),
  ('HSE_MANAGER', 'inspection.review', 'FULL'),
  ('HSE_OFFICER', 'inspection.review', 'LIMITED'),
  ('HSE_MANAGER', 'observation.create', 'FULL'),
  ('HSE_OFFICER', 'observation.create', 'FULL'),
  ('SITE_ADMIN', 'observation.create', 'FULL'),
  ('SUPERVISOR', 'observation.create', 'FULL'),
  ('MEDICAL_OFFICER', 'observation.create', 'FULL'),
  ('TRAINER', 'observation.create', 'FULL'),
  ('WORKER', 'observation.create', 'FULL'),
  ('COMPANY_ADMIN', 'observation.read', 'FULL'),
  ('HSE_MANAGER', 'observation.read', 'FULL'),
  ('HSE_OFFICER', 'observation.read', 'FULL'),
  ('SITE_ADMIN', 'observation.read', 'FULL'),
  ('SUPERVISOR', 'observation.read', 'TEAM'),
  ('AUDITOR', 'observation.read', 'FULL'),
  ('WORKER', 'observation.read', 'LIMITED'),
  ('HSE_MANAGER', 'observation.review', 'FULL'),
  ('HSE_OFFICER', 'observation.review', 'FULL'),
  ('SUPERVISOR', 'observation.review', 'LIMITED'),
  ('COMPANY_ADMIN', 'corrective_action.read', 'FULL'),
  ('HSE_MANAGER', 'corrective_action.read', 'FULL'),
  ('HSE_OFFICER', 'corrective_action.read', 'FULL'),
  ('SITE_ADMIN', 'corrective_action.read', 'FULL'),
  ('SUPERVISOR', 'corrective_action.read', 'TEAM'),
  ('AUDITOR', 'corrective_action.read', 'FULL'),
  ('WORKER', 'corrective_action.read', 'LIMITED'),
  ('HSE_MANAGER', 'corrective_action.create', 'FULL'),
  ('HSE_OFFICER', 'corrective_action.create', 'FULL'),
  ('SUPERVISOR', 'corrective_action.create', 'FULL'),
  ('HSE_MANAGER', 'corrective_action.assign', 'FULL'),
  ('HSE_OFFICER', 'corrective_action.assign', 'FULL'),
  ('SUPERVISOR', 'corrective_action.assign', 'FULL'),
  ('HSE_MANAGER', 'corrective_action.update', 'FULL'),
  ('HSE_OFFICER', 'corrective_action.update', 'FULL'),
  ('SITE_ADMIN', 'corrective_action.update', 'FULL'),
  ('SUPERVISOR', 'corrective_action.update', 'FULL'),
  ('MEDICAL_OFFICER', 'corrective_action.update', 'LIMITED'),
  ('TRAINER', 'corrective_action.update', 'LIMITED'),
  ('WORKER', 'corrective_action.update', 'LIMITED'),
  ('HSE_MANAGER', 'corrective_action.verify', 'FULL'),
  ('HSE_OFFICER', 'corrective_action.verify', 'LIMITED'),
  ('COMPANY_ADMIN', 'dashboard.view', 'FULL'),
  ('EXECUTIVE', 'dashboard.view', 'FULL'),
  ('HSE_MANAGER', 'dashboard.view', 'FULL'),
  ('HSE_OFFICER', 'dashboard.view', 'FULL'),
  ('SITE_ADMIN', 'dashboard.view', 'FULL'),
  ('SUPERVISOR', 'dashboard.view', 'LIMITED'),
  ('MEDICAL_OFFICER', 'dashboard.view', 'LIMITED'),
  ('TRAINER', 'dashboard.view', 'LIMITED'),
  ('AUDITOR', 'dashboard.view', 'FULL'),
  ('WORKER', 'dashboard.view', 'LIMITED'),
  ('COMPANY_ADMIN', 'compliance.view', 'FULL'),
  ('EXECUTIVE', 'compliance.view', 'FULL'),
  ('HSE_MANAGER', 'compliance.view', 'FULL'),
  ('HSE_OFFICER', 'compliance.view', 'FULL'),
  ('SITE_ADMIN', 'compliance.view', 'FULL'),
  ('SUPERVISOR', 'compliance.view', 'LIMITED'),
  ('AUDITOR', 'compliance.view', 'FULL'),
  ('COMPANY_ADMIN', 'report.export', 'FULL'),
  ('EXECUTIVE', 'report.export', 'FULL'),
  ('HSE_MANAGER', 'report.export', 'FULL'),
  ('HSE_OFFICER', 'report.export', 'FULL'),
  ('SITE_ADMIN', 'report.export', 'LIMITED'),
  ('AUDITOR', 'report.export', 'FULL'),
  ('COMPANY_ADMIN', 'ai_recommendation.read', 'FULL'),
  ('EXECUTIVE', 'ai_recommendation.read', 'LIMITED'),
  ('HSE_MANAGER', 'ai_recommendation.read', 'FULL'),
  ('HSE_OFFICER', 'ai_recommendation.read', 'FULL'),
  ('SUPERVISOR', 'ai_recommendation.read', 'TEAM'),
  ('MEDICAL_OFFICER', 'ai_recommendation.read', 'LIMITED'),
  ('TRAINER', 'ai_recommendation.read', 'LIMITED'),
  ('AUDITOR', 'ai_recommendation.read', 'LIMITED'),
  ('WORKER', 'ai_recommendation.read', 'SELF'),
  ('HSE_MANAGER', 'ai_recommendation.generate', 'FULL'),
  ('HSE_OFFICER', 'ai_recommendation.generate', 'FULL'),
  ('HSE_MANAGER', 'ai_recommendation.review', 'FULL'),
  ('HSE_OFFICER', 'ai_recommendation.review', 'LIMITED'),
  ('COMPANY_ADMIN', 'ai_recommendation.configure', 'FULL'),
  ('PLATFORM_SUPER_ADMIN', 'notification.read', 'FULL'),
  ('COMPANY_ADMIN', 'notification.read', 'FULL'),
  ('EXECUTIVE', 'notification.read', 'FULL'),
  ('HSE_MANAGER', 'notification.read', 'FULL'),
  ('HSE_OFFICER', 'notification.read', 'FULL'),
  ('SITE_ADMIN', 'notification.read', 'FULL'),
  ('SUPERVISOR', 'notification.read', 'FULL'),
  ('MEDICAL_OFFICER', 'notification.read', 'FULL'),
  ('TRAINER', 'notification.read', 'FULL'),
  ('AUDITOR', 'notification.read', 'FULL'),
  ('WORKER', 'notification.read', 'FULL'),
  ('COMPANY_ADMIN', 'notification.configure', 'FULL'),
  ('PLATFORM_SUPER_ADMIN', 'audit.view', 'LIMITED'),
  ('COMPANY_ADMIN', 'audit.view', 'FULL'),
  ('HSE_MANAGER', 'audit.view', 'LIMITED'),
  ('AUDITOR', 'audit.view', 'FULL'),
  ('COMPANY_ADMIN', 'configuration.manage', 'FULL'),
  ('PLATFORM_SUPER_ADMIN', 'platform.configure', 'FULL'),
  ('PLATFORM_SUPER_ADMIN', 'integration.manage', 'LIMITED'),
  ('COMPANY_ADMIN', 'integration.manage', 'FULL');

alter table role alter column name set not null;
alter table role alter column phase set not null;
alter table permission alter column module set not null;
alter table permission alter column action set not null;

-- ---------------------------------------------------------------- user_profile (dari app_user M0)
alter table app_user rename to user_profile;
alter table user_profile
  add column if not exists full_name text,
  add column if not exists phone text,
  add column if not exists status text not null default 'ACTIVE',
  add column if not exists last_login_at timestamptz,
  add column if not exists mfa_enabled boolean not null default false,
  add column if not exists preferred_language text not null default 'id',
  add column if not exists created_at timestamptz not null default now();
alter table user_profile alter column email drop not null;
-- organization_id NULL hanya untuk Platform Super Admin (tidak melihat data tenant, BR-PLT01-002)
alter table user_profile alter column organization_id drop not null;
alter table user_profile
  add constraint user_profile_status_chk check (status in ('INVITED', 'ACTIVE', 'LOCKED', 'DEACTIVATED')),
  add constraint user_profile_language_chk check (preferred_language in ('id', 'en')),
  add constraint user_profile_contact_chk check (email is not null or phone is not null);
create unique index if not exists user_profile_email_lower_uq on user_profile (organization_id, lower(email)) where email is not null;

-- ---------------------------------------------------------------- user_role_assignment dengan scope
alter table user_role_assignment drop constraint if exists user_role_assignment_site_id_organization_id_fkey;
alter table user_role_assignment rename column site_id to scope_id;
alter table user_role_assignment
  add column if not exists scope_type text,
  add column if not exists valid_from timestamptz not null default now(),
  add column if not exists valid_until timestamptz,
  add column if not exists granted_by uuid,
  add column if not exists granted_at timestamptz not null default now(),
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_by uuid;
update user_role_assignment set scope_type = case when scope_id is null then 'ORGANIZATION' else 'SITE' end where scope_type is null;
alter table user_role_assignment alter column scope_type set not null;
alter table user_role_assignment
  add constraint ura_scope_chk check (case scope_type
    when 'SITE' then scope_id is not null
    when 'DEPARTMENT' then scope_id is not null
    when 'TEAM' then scope_id is not null
    when 'CONTRACTOR' then scope_id is not null
    when 'ORGANIZATION' then scope_id is null
    when 'PLATFORM' then scope_id is null
    when 'SELF' then scope_id is null
    else false end),
  add constraint ura_not_self_granted_chk check (granted_by is null or granted_by <> user_id),
  add constraint ura_validity_chk check (valid_until is null or valid_until > valid_from),
  add constraint ura_revoked_by_chk check (revoked_by is null or revoked_at is not null),
  add constraint ura_granted_by_fk foreign key (granted_by) references user_profile(id),
  add constraint ura_revoked_by_fk foreign key (revoked_by) references user_profile(id);

create unique index ura_active_uq on user_role_assignment (user_id, role_code, scope_type, scope_id) nulls not distinct
  where revoked_at is null;
-- Satu penugasan CONTRACTOR aktif per pengguna (B-26, BR-PLT01-012)
create unique index ura_one_contractor_uq on user_role_assignment (user_id) where scope_type = 'CONTRACTOR' and revoked_at is null;

-- Validasi yang tidak dapat ditulis sebagai CHECK: scope sesuai role, role aktif, objek scope milik organisasi
create function app.ura_validate() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare r role%rowtype;
begin
  select * into r from role where code = new.role_code;
  if not (new.scope_type = any (r.scope_levels)) then
    raise exception 'SCOPE_NOT_ALLOWED: role % tidak menerima scope %', new.role_code, new.scope_type using errcode = '23514';
  end if;
  -- Role belum aktif (mis. CONTRACTOR_ADMIN sebelum P2) ditolak, kecuali data uji sintetis (AC-PLT01-017, DB-002 §4)
  if tg_op = 'INSERT' and not r.is_active and coalesce(current_setting('app.allow_inactive_roles', true), '') <> 'on' then
    raise exception 'ROLE_NOT_ACTIVE: role % belum aktif', new.role_code using errcode = '23514';
  end if;
  if new.scope_type = 'SITE' and not exists (select 1 from site s where s.id = new.scope_id and s.organization_id = new.organization_id) then
    raise exception 'SCOPE_INVALID: site bukan milik organisasi' using errcode = '23503';
  end if;
  if new.scope_type = 'PLATFORM' and new.role_code <> 'PLATFORM_SUPER_ADMIN' then
    raise exception 'SCOPE_NOT_ALLOWED: scope PLATFORM hanya untuk PLATFORM_SUPER_ADMIN' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger ura_validate before insert or update on user_role_assignment
  for each row execute function app.ura_validate();

-- ---------------------------------------------------------------- fungsi identitas dan izin (diperbarui)
-- Penugasan aktif: belum dicabut, dalam masa berlaku, pengguna berstatus ACTIVE. Pencabutan berlaku pada
-- permintaan berikutnya karena dibaca dari database setiap kueri (AR-010, FR-PLT01-017).
create or replace function app.current_org() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select organization_id from user_profile where id = app.current_user_id() and status = 'ACTIVE'
$$;

create or replace function app.has_org_wide(perm text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from user_role_assignment ura
    join role_permission rp on rp.role_code = ura.role_code
    join user_profile up on up.id = ura.user_id and up.status = 'ACTIVE'
    where ura.user_id = app.current_user_id()
      and ura.scope_type = 'ORGANIZATION'
      and ura.revoked_at is null and ura.valid_from <= now() and (ura.valid_until is null or ura.valid_until > now())
      and rp.permission_code = perm and rp.constraint_level in ('FULL', 'TEAM'))
$$;

create or replace function app.permitted_sites(perm text) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct ura.scope_id), '{}'::uuid[])
  from user_role_assignment ura
  join role_permission rp on rp.role_code = ura.role_code
  join user_profile up on up.id = ura.user_id and up.status = 'ACTIVE'
  where ura.user_id = app.current_user_id()
    and ura.scope_type = 'SITE'
    and ura.revoked_at is null and ura.valid_from <= now() and (ura.valid_until is null or ura.valid_until > now())
    and rp.permission_code = perm and rp.constraint_level in ('FULL', 'TEAM')
$$;

create or replace function app.has_permission(perm text, p_site uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.has_org_wide(perm) or p_site = any (app.permitted_sites(perm))
$$;

-- Daftar permission efektif pengguna aktif (untuk GET /me dan pemeriksaan di Core API)
create function app.my_permissions()
returns table (permission_code text, constraint_level text, role_code text, scope_type text, scope_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select rp.permission_code, rp.constraint_level, ura.role_code, ura.scope_type, ura.scope_id
  from user_role_assignment ura
  join role r on r.code = ura.role_code
  join role_permission rp on rp.role_code = ura.role_code
  join user_profile up on up.id = ura.user_id and up.status = 'ACTIVE'
  where ura.user_id = app.current_user_id()
    and ura.revoked_at is null and ura.valid_from <= now() and (ura.valid_until is null or ura.valid_until > now())
$$;

revoke execute on all functions in schema app from public;
grant execute on all functions in schema app to app_authenticated, app_worker;

-- ---------------------------------------------------------------- RLS: nama permission resmi PB-009
drop policy if exists site_read on site;
create policy site_read on site for select
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('organization.read')) or id = any ((select app.permitted_sites('organization.read'))::uuid[])));

drop policy if exists app_user_read on user_profile;
-- Pengguna selalu boleh membaca profilnya sendiri; daftar pengguna untuk pemegang user.manage atau role.manage
create policy user_profile_read on user_profile for select
  using (id = (select app.current_user_id())
         or (organization_id = (select app.current_org())
             and ((select app.has_org_wide('user.manage')) or (select app.has_org_wide('role.manage')))));

drop policy if exists user_role_assignment_read on user_role_assignment;
create policy user_role_assignment_read on user_role_assignment for select
  using (user_id = (select app.current_user_id())
         or (organization_id = (select app.current_org())
             and ((select app.has_org_wide('user.manage')) or (select app.has_org_wide('role.manage')))));

drop policy if exists worker_read on worker;
create policy worker_read on worker for select
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('worker.read')) or site_id = any ((select app.permitted_sites('worker.read'))::uuid[])));
drop policy if exists worker_write on worker;
create policy worker_insert on worker for insert
  with check (organization_id = (select app.current_org())
         and ((select app.has_org_wide('worker.create')) or site_id = any ((select app.permitted_sites('worker.create'))::uuid[])));
create policy worker_update on worker for update
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('worker.update')) or site_id = any ((select app.permitted_sites('worker.update'))::uuid[])))
  with check (organization_id = (select app.current_org())
         and ((select app.has_org_wide('worker.update')) or site_id = any ((select app.permitted_sites('worker.update'))::uuid[])));
-- Tidak ada kebijakan DELETE: data memakai soft delete (PB-009 worker.deactivate)
revoke delete on worker from app_authenticated;

drop policy if exists competency_record_read on competency_record;
create policy competency_record_read on competency_record for select
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('competency.read')) or site_id = any ((select app.permitted_sites('competency.read'))::uuid[])));
drop policy if exists competency_record_write on competency_record;
create policy competency_record_insert on competency_record for insert
  with check (organization_id = (select app.current_org())
         and ((select app.has_org_wide('competency.update')) or site_id = any ((select app.permitted_sites('competency.update'))::uuid[])));
create policy competency_record_update on competency_record for update
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('competency.update')) or site_id = any ((select app.permitted_sites('competency.update'))::uuid[])))
  with check (organization_id = (select app.current_org())
         and ((select app.has_org_wide('competency.update')) or site_id = any ((select app.permitted_sites('competency.update'))::uuid[])));
revoke delete on competency_record from app_authenticated;

drop policy if exists medical_status_read on medical_status;
create policy medical_status_read on medical_status for select
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('medical.read_status')) or site_id = any ((select app.permitted_sites('medical.read_status'))::uuid[])));

-- Detail Medical: hanya level FULL tingkat organisasi (Medical Officer). HSE Manager (LIMITED) ditolak sampai
-- otorisasi tercatat dibangun (M3).
drop policy if exists medical_detail_read on medical_detail;
create policy medical_detail_read on medical_detail for select
  using (organization_id = (select app.current_org()) and (select app.has_org_wide('medical.read_detail')));

drop policy if exists readiness_snapshot_read on readiness_snapshot;
create policy readiness_snapshot_read on readiness_snapshot for select
  using (organization_id = (select app.current_org())
         and ((select app.has_org_wide('readiness.read')) or site_id = any ((select app.permitted_sites('readiness.read'))::uuid[])));

-- audit_log_read memakai audit.view (nama sama dengan PB-009), dibuat ulang agar memakai fungsi terbaru
drop policy if exists audit_log_read on audit_log;
create policy audit_log_read on audit_log for select
  using (organization_id = (select app.current_org()) and (select app.has_org_wide('audit.view')));

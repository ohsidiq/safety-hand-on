-- 0002_reference_data.sql
-- Data acuan peran dan izin untuk uji M0. ILUSTRASI untuk membuktikan pola RLS,
-- bukan Permission Matrix PB-009. PB-009 menggantikan ini di M1.

insert into role(code) values
  ('ORG_ADMIN'), ('HSE_MANAGER'), ('HSE_OFFICER'), ('SUPERVISOR'), ('MEDICAL_REVIEWER');

insert into permission(code) values
  ('site.view'), ('user.view'), ('worker.view'), ('worker.manage'),
  ('competency.view'), ('competency.manage'),
  ('medical.view_status'), ('medical.view_detail'),
  ('readiness.view'), ('audit.view');

insert into role_permission(role_code, permission_code) values
  ('ORG_ADMIN','site.view'), ('ORG_ADMIN','user.view'), ('ORG_ADMIN','worker.view'), ('ORG_ADMIN','worker.manage'),
  ('ORG_ADMIN','competency.view'), ('ORG_ADMIN','competency.manage'), ('ORG_ADMIN','medical.view_status'),
  ('ORG_ADMIN','readiness.view'), ('ORG_ADMIN','audit.view'),
  ('HSE_MANAGER','site.view'), ('HSE_MANAGER','worker.view'), ('HSE_MANAGER','competency.view'),
  ('HSE_MANAGER','medical.view_status'), ('HSE_MANAGER','readiness.view'), ('HSE_MANAGER','audit.view'),
  ('HSE_OFFICER','site.view'), ('HSE_OFFICER','worker.view'), ('HSE_OFFICER','competency.view'),
  ('HSE_OFFICER','competency.manage'), ('HSE_OFFICER','medical.view_status'), ('HSE_OFFICER','readiness.view'),
  -- Supervisor tidak punya medical.view_status: hanya melihat alasan "Syarat Medical belum terpenuhi" lewat readiness
  ('SUPERVISOR','site.view'), ('SUPERVISOR','worker.view'), ('SUPERVISOR','competency.view'), ('SUPERVISOR','readiness.view'),
  ('MEDICAL_REVIEWER','worker.view'), ('MEDICAL_REVIEWER','medical.view_status'), ('MEDICAL_REVIEWER','medical.view_detail');

# packages/rbac

`permission-matrix.json` adalah salinan mesin dari **PB-009 v3.5** (Permission Matrix) dan **PB-008 v3.5** (User
Roles) di vault dokumentasi. Migrasi `db/migrations/0005_identity_access.sql` dibangkitkan dari berkas ini, dan uji
`apps/api/test/rbac-matrix.integration.test.ts` memastikan database sama persis.

Level: `FULL` (✔), `LIMITED` (◐), `TEAM` (T), `SELF` (S). Simbol ✖ tidak dicatat (ditolak bawaan, BR-PLT01-001).

Mengubah matriks: perbarui PB-009 lebih dulu (dokumen adalah sumber kebenaran), lalu berkas ini, lalu migrasi baru
yang memperbarui `role_permission`. Jangan mengubah migrasi yang sudah diterapkan.

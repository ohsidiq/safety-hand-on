/**
 * Menu per peran (UIUX-002 §3, §5, §13). Dibentuk dari permission efektif pada GET /auth/me.
 * Hanya presentasi (IA-008): server tetap memeriksa setiap permintaan.
 * Item yang belum dibangun (`built: false`) tidak ditampilkan (IA-006), bukan dinonaktifkan.
 */
export interface NavItem {
  href: string;
  label: string;
  domain: "Beranda" | "People" | "Readiness" | "Operations" | "Intelligence" | "Platform" | "Akun";
  /** Salah satu permission ini cukup. Kosong = semua pengguna yang login. */
  anyOf: string[];
  phase: "P0" | "P1" | "P2" | "P3" | "P4";
  built: boolean;
}

export const NAV: NavItem[] = [
  { href: "/dashboard", label: "Beranda", domain: "Beranda", anyOf: [], phase: "P0", built: true },
  { href: "/workers", label: "Pekerja", domain: "People", anyOf: ["worker.read"], phase: "P0", built: true },
  // UIUX-002 §5: Struktur Organisasi untuk Company Admin dan Site Admin (pengelola struktur)
  {
    href: "/organization",
    label: "Struktur Organisasi",
    domain: "People",
    anyOf: ["organization.manage"],
    phase: "P0",
    built: true,
  },
  // M4.2 (API-014 bagian 6): daftar syarat per jabatan (Requirement Profile), dikelola Company Admin dan HSE Manager
  {
    href: "/requirement-profiles",
    label: "Syarat Jabatan",
    domain: "Readiness",
    anyOf: ["readiness_profile.manage"],
    phase: "P1",
    built: true,
  },
  // M4.3 (API-014 bagian 7): pemindai QR Safety Passport untuk peran yang membaca kesiapan pekerja lain
  {
    href: "/passport/scan",
    label: "Pindai QR",
    domain: "Readiness",
    anyOf: ["readiness.read"],
    phase: "P1",
    built: true,
  },
  // M3.6b (UIUX-005 §6.2): antrean verifikasi gabungan semua modul, terlama dahulu
  {
    href: "/verifications",
    label: "Antrean Verifikasi",
    domain: "Readiness",
    anyOf: ["competency.verify", "authorization.verify", "simper.verify", "medical.verify"],
    phase: "P0",
    built: true,
  },
  // SRS-WF003: antrean verifikasi (HSE Manager) dan master kompetensi (Company Admin, HSE Manager)
  {
    href: "/competencies",
    label: "Kompetensi",
    domain: "Readiness",
    anyOf: ["competency.verify", "readiness_profile.manage"],
    phase: "P0",
    built: true,
  },
  // SRS-WF005: Otorisasi Kerja (bukan Permit To Work): antrean verifikasi dan jenis
  {
    href: "/authorizations",
    label: "Otorisasi Kerja",
    domain: "Readiness",
    anyOf: ["authorization.verify", "readiness_profile.manage"],
    phase: "P0",
    built: true,
  },
  // SRS-WF006: SIMPER dan otorisasi per kelas alat: antrean verifikasi dan jenis
  {
    href: "/simpers",
    label: "SIMPER",
    domain: "Readiness",
    anyOf: ["simper.verify", "readiness_profile.manage"],
    phase: "P0",
    built: true,
  },
  // SRS-WF004 v1.4: penetapan Fit to Work (Dokter, B-27), jenis pemeriksaan dan jenis kerja khusus
  {
    href: "/medical",
    label: "Medical",
    domain: "Readiness",
    anyOf: ["medical.verify", "readiness_profile.manage"],
    phase: "P0",
    built: true,
  },
  {
    href: "/users",
    label: "Pengguna dan Akses",
    domain: "Platform",
    anyOf: ["user.manage", "role.manage"],
    phase: "P0",
    built: false,
  },
  { href: "/settings", label: "Pengaturan", domain: "Platform", anyOf: ["configuration.manage"], phase: "P0", built: false },
  { href: "/notifications", label: "Notifikasi", domain: "Platform", anyOf: ["notification.read"], phase: "P0", built: true },
  { href: "/audit", label: "Jejak Audit", domain: "Platform", anyOf: ["audit.view"], phase: "P0", built: true },
  { href: "/profile", label: "Profil", domain: "Akun", anyOf: [], phase: "P0", built: true },
];

/** Fase yang sudah dirilis (B-09). Menu fase berikutnya tidak tampil. P1 dibuka mulai M4.2 (Readiness, MVP = P0 + P1). */
export const RELEASED_PHASES: ReadonlySet<NavItem["phase"]> = new Set(["P0", "P1"]);

export function visibleNav(permissions: readonly string[], items: NavItem[] = NAV): NavItem[] {
  const have = new Set(permissions);
  return items.filter(
    (i) => i.built && RELEASED_PHASES.has(i.phase) && (i.anyOf.length === 0 || i.anyOf.some((p) => have.has(p))),
  );
}

export function canSee(permissions: readonly string[], href: string): boolean {
  return visibleNav(permissions).some((i) => i.href === href);
}

/** Nama peran untuk tampilan (PB-008). */
export const ROLE_LABEL: Record<string, string> = {
  PLATFORM_SUPER_ADMIN: "Platform Super Admin",
  COMPANY_ADMIN: "Company Admin",
  EXECUTIVE: "Executive",
  HSE_MANAGER: "HSE Manager",
  HSE_OFFICER: "HSE Officer",
  SITE_ADMIN: "Site Admin",
  SUPERVISOR: "Supervisor",
  MEDICAL_OFFICER: "Medical Officer",
  DOCTOR: "Dokter",
  TRAINER: "Trainer",
  AUDITOR: "Auditor",
  WORKER: "Worker",
  CONTRACTOR_ADMIN: "Contractor Admin",
};

export const SCOPE_LABEL: Record<string, string> = {
  PLATFORM: "Platform",
  ORGANIZATION: "Seluruh perusahaan",
  SITE: "Site",
  DEPARTMENT: "Department",
  TEAM: "Tim",
  CONTRACTOR: "Kontraktor",
  SELF: "Diri sendiri",
};

/** Label kode aksi audit (DB-007 §3) untuk tampilan. Kode yang tidak dikenal ditampilkan apa adanya. */
export const ACTION_LABEL: Record<string, string> = {
  "auth.login_success": "Masuk",
  "access.role_assigned": "Peran diberikan",
  "access.role_revoked": "Peran dicabut",
  "access.role_updated": "Peran diubah",
  "user.create": "Pengguna dibuat",
  "user.update": "Profil pengguna diubah",
  "user.deactivate": "Pengguna dinonaktifkan",
  "user.reactivate": "Pengguna diaktifkan kembali",
  "user.lock": "Pengguna dikunci",
  "audit.read": "Jejak audit dibuka",
  "report.export": "Ekspor laporan",
  "site.create": "Site dibuat",
  "site.update": "Site diubah",
  "site.deactivate": "Site dinonaktifkan",
  "site.reactivate": "Site diaktifkan kembali",
  "department.create": "Department dibuat",
  "department.update": "Department diubah",
  "department.deactivate": "Department dinonaktifkan",
  "department.reactivate": "Department diaktifkan kembali",
  "division.create": "Divisi dibuat",
  "division.update": "Divisi diubah",
  "division.deactivate": "Divisi dinonaktifkan",
  "division.reactivate": "Divisi diaktifkan kembali",
  "team.create": "Tim dibuat",
  "team.update": "Tim diubah",
  "team.deactivate": "Tim dinonaktifkan",
  "team.reactivate": "Tim diaktifkan kembali",
  "job_position.create": "Job Position dibuat",
  "job_position.update": "Job Position diubah",
  "job_position.deactivate": "Job Position dinonaktifkan",
  "job_position.reactivate": "Job Position diaktifkan kembali",
  "equipment_class.create": "Kelas alat dibuat",
  "equipment_class.update": "Kelas alat diubah",
  "equipment_class.deactivate": "Kelas alat dinonaktifkan",
  "equipment_class.reactivate": "Kelas alat diaktifkan kembali",
  "team.member_add": "Anggota tim ditambahkan",
  "team.member_end": "Keanggotaan tim diakhiri",
  "organization.update": "Organisasi diubah",
  "worker.assign": "Penempatan pekerja",
  "worker.import": "Impor pekerja",
  "worker.resign": "Pekerja berhenti",
  "worker.reactivate": "Pekerja diaktifkan kembali",
  "worker.deactivate": "Pekerja dinonaktifkan",
  "worker.reinstate": "Skorsing diakhiri",
  "worker.suspend": "Pekerja diskors",
  "worker.update": "Data pekerja diubah",
  "worker.create": "Pekerja dibuat",
  "competency.create": "Kompetensi dicatat",
  "competency.update": "Kompetensi diubah",
  "competency.verify": "Kompetensi diverifikasi",
  "competency.reject": "Kompetensi ditolak",
  "competency.resubmit": "Kompetensi diajukan ulang",
  "competency.certificate_add": "Sertifikat ditambahkan",
  "competency.certificate_download": "Sertifikat diunduh",
  "competency.deactivate": "Master kompetensi dinonaktifkan",
  "competency.reactivate": "Master kompetensi diaktifkan kembali",
  "authorization.create": "Otorisasi Kerja diajukan",
  "authorization.update": "Otorisasi Kerja diubah",
  "authorization.verify": "Otorisasi Kerja diverifikasi",
  "authorization.reject": "Otorisasi Kerja ditolak",
  "authorization.resubmit": "Otorisasi Kerja diajukan ulang",
  "authorization.suspend": "Otorisasi Kerja dibekukan",
  "authorization.reinstate": "Otorisasi Kerja dipulihkan",
  "authorization.revoke": "Otorisasi Kerja dicabut",
  "authorization.document_access": "Dokumen Otorisasi Kerja dibuka",
  "authorization_type.create": "Jenis otorisasi dibuat",
  "authorization_type.update": "Jenis otorisasi diubah",
  "authorization_type.deactivate": "Jenis otorisasi dinonaktifkan",
  "authorization_type.reactivate": "Jenis otorisasi diaktifkan kembali",
  "simper.create": "SIMPER diajukan",
  "simper.update": "SIMPER diubah",
  "simper.verify": "SIMPER diverifikasi",
  "simper.reject": "SIMPER ditolak",
  "simper.resubmit": "SIMPER diajukan ulang",
  "simper.suspend": "SIMPER dibekukan",
  "simper.reinstate": "SIMPER dipulihkan",
  "simper.revoke": "SIMPER dicabut",
  "simper.document_access": "Dokumen SIMPER dibuka",
  "simper_authorization.create": "Kelas alat SIMPER ditambahkan",
  "simper_authorization.update": "Kelas alat SIMPER diubah",
  "simper_authorization.suspend": "Kelas alat SIMPER dibekukan",
  "simper_authorization.reinstate": "Kelas alat SIMPER dipulihkan",
  "simper_authorization.revoke": "Kelas alat SIMPER dicabut",
  "simper_type.create": "Jenis SIMPER dibuat",
  "simper_type.update": "Jenis SIMPER diubah",
  "simper_type.deactivate": "Jenis SIMPER dinonaktifkan",
  "simper_type.reactivate": "Jenis SIMPER diaktifkan kembali",
  "medical.create": "MCU dicatat",
  "medical.update": "MCU diubah",
  "medical.verify": "Fit to Work ditetapkan",
  "medical.reject": "MCU ditolak",
  "medical.resubmit": "MCU diajukan ulang",
  "medical.restriction_add": "Pembatasan operasional ditambahkan",
  "medical.restriction_lift": "Pembatasan operasional diakhiri",
  "medical.read_detail": "Detail medis dibuka",
  "medical.document_access": "Dokumen MCU dibuka",
  "medical.access_grant": "Akses detail medis diberikan",
  "medical.access_grant_revoke": "Akses detail medis dicabut",
  "medical.clearance_issue": "Pemeriksaan kesiapan kerja khusus dicatat",
  "medical.clearance_revoke": "Kesiapan kerja khusus dicabut",
  "medical_clearance_type.create": "Jenis kerja khusus dibuat",
  "medical_clearance_type.update": "Jenis kerja khusus diubah",
  "medical_clearance_type.deactivate": "Jenis kerja khusus dinonaktifkan",
  "medical_clearance_type.reactivate": "Jenis kerja khusus diaktifkan kembali",
  "medical_exam_type.create": "Jenis pemeriksaan dibuat",
  "medical_exam_type.update": "Jenis pemeriksaan diubah",
  "medical_exam_type.deactivate": "Jenis pemeriksaan dinonaktifkan",
  "medical_exam_type.reactivate": "Jenis pemeriksaan diaktifkan kembali",
  "requirement_profile.create": "Daftar syarat jabatan dibuat",
  "requirement_profile.update": "Daftar syarat jabatan diubah atau diaktifkan",
  "requirement_profile.item_add": "Syarat ditambahkan ke daftar",
  "requirement_profile.item_update": "Syarat pada daftar diubah",
  "requirement_profile.item_remove": "Syarat dihapus dari daftar",
  "readiness.evaluate": "Kesiapan pekerja dinilai ulang",
  "passport.scan": "QR Safety Passport dipindai",
};

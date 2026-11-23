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
  { href: "/workers", label: "Pekerja", domain: "People", anyOf: ["worker.read"], phase: "P0", built: false },
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

/** Fase yang sudah dirilis (B-09). Menu fase berikutnya tidak tampil. */
export const RELEASED_PHASES: ReadonlySet<NavItem["phase"]> = new Set(["P0"]);

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
};

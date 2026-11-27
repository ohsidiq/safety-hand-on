import { createRoute, z } from "@hono/zod-openapi";
import type { Tx } from "@soh/db";
import {
  ApiFailure,
  baseErrors,
  type Deps,
  ErrorResponse,
  guard,
  guardAny,
  IfMatch,
  IfMatchValue,
  json,
  LIST_LIMIT,
  list,
  ok,
  parseIfMatch,
  pick,
  type Row,
  respondFailure,
  run,
  security,
  serialize,
  updateRow,
  type V1,
  writeErrors,
} from "./route-kit.js";

/**
 * Struktur organisasi (API-002 §3-§6, §8-§11): organisasi sendiri, Site, Department, Division, Team (dan anggota),
 * Job Position, Equipment Class.
 * - Organisasi pemanggil dari token; tidak ada id organisasi pada URL (§3). Objek di luar organisasi/scope -> 404 (ORG-API-007).
 * - Tidak ada penghapusan; penonaktifan lewat aksi deactivate (ORG-API-003). Pengecualian B-28: master yang ditandai
 *   `deletable` (jenis pemeriksaan MCU, jenis kerja khusus) boleh dihapus selama belum pernah dipakai (409 MASTER_IN_USE). Struktur berpekerja aktif ditolak (ORG-API-004).
 * - PATCH wajib If-Match: <version> (API-000 §10). Audit dicatat pemicu database (ORG-API-010).
 * - Semua kueri lewat withUser (ARCH-002); RLS menegakkan scope Site.
 * Belum di M2.3: area platform /platform/tenants, /organization/settings (configuration.manage), evaluasi ulang readiness
 * saat timezone/posisi berubah (ORG-API-009, menunggu Readiness Engine M4), Contractor (API-003 §11a, M2.4/M2.5).
 */

const Name = z.string().trim().min(2).max(150);
const Code = z
  .string()
  .regex(/^[A-Z0-9][A-Z0-9-]{1,29}$/)
  .openapi({ description: "Huruf besar, angka, tanda hubung; 2-30 karakter", example: "SITE-A" });
const OptText = (max: number) => z.string().trim().max(max).nullable().optional();
const Timezone = z.string().min(1).max(64).openapi({ description: "Nama zona IANA", example: "Asia/Makassar" });
const Status = z.enum(["ACTIVE", "INACTIVE"]);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Meta = {
  status: Status,
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
};

// ---------------------------------------------------------------- definisi sumber daya

interface Parent {
  /** Nama parameter path koleksi, mis. site_id. */
  param: string;
  table: string;
  /** Kolom yang diambil dari induk untuk diisi ke baris baru. */
  copy: Record<string, string>;
}

interface ResourceDef {
  entity: string;
  tag: string;
  label: string;
  table: string;
  itemBase: string;
  collectionPath: string;
  parent?: Parent;
  /** Kolom keluaran (SQL). */
  columns: string;
  item: z.ZodType;
  create: z.ZodObject;
  patch: z.ZodObject;
  /** Kolom yang boleh ditulis lewat create/patch. */
  writable: string[];
  /** Isu galat saat penonaktifan ditolak karena masih dipakai pekerja aktif. */
  inUseIssue: string;
  /** Kueri jumlah pekerja aktif terdampak ($1 = id), untuk alasan penolakan di UI (UIUX-005 §3). */
  affectedSql?: string;
  prepareCreate?: (tx: Tx, body: Row, orgId: string) => Promise<void>;
  /** Permission baca (bawaan organization.read) dan kelola (bawaan organization.manage). */
  readPerm?: string;
  managePerm?: string;
  /** Permission tingkat SELF yang juga boleh membaca (mis. pekerja memilih master saat mencatat kompetensinya). */
  readSelfAlso?: string[];
  /** Permission FULL/TEAM lain yang juga boleh membaca (mis. medical.verify membaca jenis pemeriksaan). */
  readAlso?: string[];
  /** B-28: boleh dihapus selama belum dirujuk data lain (kunci asing menolak -> 409 MASTER_IN_USE). */
  deletable?: boolean;
}

const META_COLS = "status, version, created_at, updated_at";
const ACTIVE_WORKER = "w.worker_status in ('ACTIVE', 'SUSPENDED') and w.deleted_at is null";

const Site = z
  .object({
    id: z.uuid(),
    name: z.string(),
    code: z.string(),
    location: z.string().nullable(),
    timezone: z.string(),
    ...Meta,
  })
  .openapi("Site");
const Department = z
  .object({ id: z.uuid(), site_id: z.uuid(), name: z.string(), code: z.string(), ...Meta })
  .openapi("Department");
const Division = z
  .object({ id: z.uuid(), site_id: z.uuid(), department_id: z.uuid(), name: z.string(), code: z.string(), ...Meta })
  .openapi("Division");
const Team = z
  .object({ id: z.uuid(), site_id: z.uuid(), department_id: z.uuid().nullable(), name: z.string(), code: z.string(), ...Meta })
  .openapi("Team");
const JobPosition = z
  .object({
    id: z.uuid(),
    name: z.string(),
    code: z.string(),
    job_family: z.string().nullable(),
    description: z.string().nullable(),
    ...Meta,
  })
  .openapi("JobPosition");
const EquipmentClass = z
  .object({ id: z.uuid(), name: z.string(), code: z.string(), description: z.string().nullable(), ...Meta })
  .openapi("EquipmentClass");

const ValidityMonths = z.number().int().min(1).max(600).nullable().optional();
const Competency = z
  .object({
    id: z.uuid(),
    name: z.string(),
    code: z.string(),
    description: z.string().nullable(),
    default_validity_months: z.number().int().nullable(),
    ...Meta,
  })
  .openapi("Competency");

const AuthorizationType = z
  .object({
    id: z.uuid(),
    name: z.string(),
    code: z.string(),
    description: z.string().nullable(),
    requires_work_scope: z.boolean(),
    default_validity_months: z.number().int().nullable(),
    ...Meta,
  })
  .openapi("AuthorizationType");

const SimperType = z
  .object({
    id: z.uuid(),
    name: z.string(),
    code: z.string(),
    description: z.string().nullable(),
    default_validity_months: z.number().int().nullable(),
    ...Meta,
  })
  .openapi("SimperType");

const RestrictionCode = z.string().regex(/^[A-Z][A-Z0-9_]{2,49}$/);
const MedicalClearanceType = z
  .object({
    id: z.uuid(),
    name: z.string(),
    code: z.string(),
    description: z.string().nullable(),
    validity_hours: z.number().int(),
    blocking_restriction_codes: z.array(z.string()),
    ...Meta,
  })
  .openapi("MedicalClearanceType");
const ValidityHours = z.number().int().min(1).max(24);
const MedicalExamType = z
  .object({
    id: z.uuid(),
    name: z.string(),
    code: z.string(),
    description: z.string().nullable(),
    default_validity_months: z.number().int().nullable(),
    ...Meta,
  })
  .openapi("MedicalExamType");

const RESOURCES: ResourceDef[] = [
  {
    entity: "site",
    tag: "Organization",
    label: "Site",
    table: "site",
    itemBase: "/sites",
    collectionPath: "/sites",
    columns: `id, name, code, location, timezone, ${META_COLS}`,
    item: Site,
    create: z.object({ name: Name, code: Code, location: OptText(200), timezone: Timezone.optional() }).openapi("SiteCreate"),
    patch: z
      .object({ name: Name.optional(), code: Code.optional(), location: OptText(200), timezone: Timezone.optional() })
      .openapi("SitePatch"),
    writable: ["name", "code", "location", "timezone"],
    inUseIssue: "ACTIVE_WORKERS_EXIST",
    affectedSql: `select count(*)::int as n from worker w where w.site_id = $1 and ${ACTIVE_WORKER}`,
    // timezone kosong -> default_timezone organisasi (API-002 §4)
    prepareCreate: async (tx, body, orgId) => {
      if (body.timezone) return;
      const r = await tx.query<{ default_timezone: string }>("select default_timezone from organization where id = $1", [orgId]);
      body.timezone = r.rows[0]?.default_timezone;
    },
  },
  {
    entity: "department",
    tag: "Organization",
    label: "Department",
    table: "department",
    itemBase: "/departments",
    collectionPath: "/sites/{site_id}/departments",
    parent: { param: "site_id", table: "site", copy: { site_id: "id" } },
    columns: `id, site_id, name, code, ${META_COLS}`,
    item: Department,
    create: z.object({ name: Name, code: Code }).openapi("DepartmentCreate"),
    patch: z.object({ name: Name.optional(), code: Code.optional() }).openapi("DepartmentPatch"),
    writable: ["name", "code"],
    inUseIssue: "ACTIVE_WORKERS_EXIST",
    affectedSql: `select count(*)::int as n from worker w where w.department_id = $1 and ${ACTIVE_WORKER}`,
  },
  {
    entity: "division",
    tag: "Organization",
    label: "Division",
    table: "division",
    itemBase: "/divisions",
    collectionPath: "/departments/{department_id}/divisions",
    parent: { param: "department_id", table: "department", copy: { department_id: "id", site_id: "site_id" } },
    columns: `id, site_id, department_id, name, code, ${META_COLS}`,
    item: Division,
    create: z.object({ name: Name, code: Code }).openapi("DivisionCreate"),
    patch: z.object({ name: Name.optional(), code: Code.optional() }).openapi("DivisionPatch"),
    writable: ["name", "code"],
    inUseIssue: "ACTIVE_WORKERS_EXIST",
  },
  {
    entity: "team",
    tag: "Organization",
    label: "Team",
    table: "team",
    itemBase: "/teams",
    collectionPath: "/sites/{site_id}/teams",
    parent: { param: "site_id", table: "site", copy: { site_id: "id" } },
    columns: `id, site_id, department_id, name, code, ${META_COLS}`,
    item: Team,
    create: z.object({ name: Name, code: Code, department_id: z.uuid().nullable().optional() }).openapi("TeamCreate"),
    patch: z.object({ name: Name.optional(), code: Code.optional() }).openapi("TeamPatch"),
    writable: ["name", "code", "department_id"],
    inUseIssue: "ACTIVE_MEMBERS_EXIST",
    affectedSql: `select count(distinct w.id)::int as n from team_member tm join worker w on w.id = tm.worker_id
      where tm.team_id = $1 and (tm.valid_until is null or tm.valid_until >= current_date) and ${ACTIVE_WORKER}`,
  },
  {
    entity: "job_position",
    tag: "Organization",
    label: "Job Position",
    table: "job_position",
    itemBase: "/job-positions",
    collectionPath: "/job-positions",
    columns: `id, name, code, job_family, description, ${META_COLS}`,
    item: JobPosition,
    create: z
      .object({ name: Name, code: Code, job_family: OptText(100), description: OptText(1000) })
      .openapi("JobPositionCreate"),
    patch: z
      .object({ name: Name.optional(), code: Code.optional(), job_family: OptText(100), description: OptText(1000) })
      .openapi("JobPositionPatch"),
    writable: ["name", "code", "job_family", "description"],
    inUseIssue: "POSITION_IN_USE",
    affectedSql: `select count(*)::int as n from worker w where w.job_position_id = $1 and ${ACTIVE_WORKER}`,
  },
  {
    entity: "equipment_class",
    tag: "Organization",
    label: "Equipment Class",
    table: "equipment_class",
    itemBase: "/equipment-classes",
    collectionPath: "/equipment-classes",
    columns: `id, name, code, description, ${META_COLS}`,
    item: EquipmentClass,
    create: z.object({ name: Name, code: Code, description: OptText(1000) }).openapi("EquipmentClassCreate"),
    patch: z.object({ name: Name.optional(), code: Code.optional(), description: OptText(1000) }).openapi("EquipmentClassPatch"),
    writable: ["name", "code", "description"],
    inUseIssue: "ACTIVE_WORKERS_EXIST",
  },
  {
    // API-004 §2: master kompetensi dikelola readiness_profile.manage; baca organization.read
    entity: "competency",
    tag: "Competency",
    label: "Kompetensi",
    table: "competency",
    itemBase: "/competencies",
    collectionPath: "/competencies",
    columns: `id, name, code, description, default_validity_months, ${META_COLS}`,
    item: Competency,
    create: z
      .object({ name: Name, code: Code, description: OptText(1000), default_validity_months: ValidityMonths })
      .openapi("CompetencyCreate"),
    patch: z
      .object({
        name: Name.optional(),
        code: Code.optional(),
        description: OptText(1000),
        default_validity_months: ValidityMonths,
      })
      .openapi("CompetencyPatch"),
    writable: ["name", "code", "description", "default_validity_months"],
    // 409 COMPETENCY_IN_USE (Requirement Profile ACTIVE) menyusul bersama Requirement Profile (M4)
    inUseIssue: "COMPETENCY_IN_USE",
    readPerm: "organization.read",
    managePerm: "readiness_profile.manage",
    readSelfAlso: ["competency.update"],
  },
  {
    // API-006 §2: jenis Otorisasi Kerja (bukan Permit To Work, B-04)
    entity: "authorization_type",
    tag: "Work Authorization",
    label: "Jenis Otorisasi Kerja",
    table: "authorization_type",
    itemBase: "/authorization-types",
    collectionPath: "/authorization-types",
    columns: `id, name, code, description, requires_work_scope, default_validity_months, ${META_COLS}`,
    item: AuthorizationType,
    create: z
      .object({
        name: Name,
        code: Code,
        description: OptText(1000),
        requires_work_scope: z.boolean().optional(),
        default_validity_months: ValidityMonths,
      })
      .openapi("AuthorizationTypeCreate"),
    patch: z
      .object({
        name: Name.optional(),
        code: Code.optional(),
        description: OptText(1000),
        requires_work_scope: z.boolean().optional(),
        default_validity_months: ValidityMonths,
      })
      .openapi("AuthorizationTypePatch"),
    writable: ["name", "code", "description", "requires_work_scope", "default_validity_months"],
    // 409 AUTHORIZATION_TYPE_IN_USE menyusul bersama Requirement Profile (M4)
    inUseIssue: "AUTHORIZATION_TYPE_IN_USE",
    readPerm: "organization.read",
    managePerm: "readiness_profile.manage",
    readSelfAlso: ["authorization.update"],
  },
  {
    // API-007 §2: jenis SIMPER; kelas alat tetap di /equipment-classes
    entity: "simper_type",
    tag: "SIMPER",
    label: "Jenis SIMPER",
    table: "simper_type",
    itemBase: "/simper-types",
    collectionPath: "/simper-types",
    columns: `id, name, code, description, default_validity_months, ${META_COLS}`,
    item: SimperType,
    create: z
      .object({ name: Name, code: Code, description: OptText(1000), default_validity_months: ValidityMonths })
      .openapi("SimperTypeCreate"),
    patch: z
      .object({
        name: Name.optional(),
        code: Code.optional(),
        description: OptText(1000),
        default_validity_months: ValidityMonths,
      })
      .openapi("SimperTypePatch"),
    writable: ["name", "code", "description", "default_validity_months"],
    // 409 SIMPER_TYPE_IN_USE menyusul bersama Requirement Profile (M4)
    inUseIssue: "SIMPER_TYPE_IN_USE",
    readPerm: "organization.read",
    managePerm: "readiness_profile.manage",
    readSelfAlso: ["simper.update"],
  },
  {
    // API-005 §3: jenis pemeriksaan medis (tanpa data medis pekerja)
    entity: "medical_exam_type",
    tag: "Medical",
    label: "Jenis pemeriksaan medis",
    table: "medical_exam_type",
    itemBase: "/medical-exam-types",
    collectionPath: "/medical-exam-types",
    columns: `id, name, code, description, default_validity_months, ${META_COLS}`,
    item: MedicalExamType,
    create: z
      .object({ name: Name, code: Code, description: OptText(1000), default_validity_months: ValidityMonths })
      .openapi("MedicalExamTypeCreate"),
    patch: z
      .object({
        name: Name.optional(),
        code: Code.optional(),
        description: OptText(1000),
        default_validity_months: ValidityMonths,
      })
      .openapi("MedicalExamTypePatch"),
    writable: ["name", "code", "description", "default_validity_months"],
    inUseIssue: "MEDICAL_EXAM_TYPE_IN_USE",
    readPerm: "organization.read",
    readAlso: ["medical.verify"],
    managePerm: "readiness_profile.manage",
    deletable: true,
  },
  {
    // B-27: jenis kerja khusus yang mensyaratkan pemeriksaan kesiapan Dokter (mis. kerja di ketinggian)
    entity: "medical_clearance_type",
    tag: "Medical",
    label: "Jenis kerja khusus",
    table: "medical_clearance_type",
    itemBase: "/medical-clearance-types",
    collectionPath: "/medical-clearance-types",
    columns: `id, name, code, description, validity_hours, blocking_restriction_codes, ${META_COLS}`,
    item: MedicalClearanceType,
    create: z
      .object({
        name: Name,
        code: Code,
        description: OptText(1000),
        validity_hours: ValidityHours.default(12),
        blocking_restriction_codes: z.array(RestrictionCode).max(20).default([]),
      })
      .openapi("MedicalClearanceTypeCreate"),
    patch: z
      .object({
        name: Name.optional(),
        code: Code.optional(),
        description: OptText(1000),
        validity_hours: ValidityHours.optional(),
        blocking_restriction_codes: z.array(RestrictionCode).max(20).optional(),
      })
      .openapi("MedicalClearanceTypePatch"),
    writable: ["name", "code", "description", "validity_hours", "blocking_restriction_codes"],
    inUseIssue: "MEDICAL_CLEARANCE_TYPE_IN_USE",
    readPerm: "organization.read",
    readAlso: ["medical.clearance"],
    managePerm: "readiness_profile.manage",
    deletable: true,
  },
];

// ---------------------------------------------------------------- pendaftaran

export function registerOrgStructure(v1: V1, deps: Deps) {
  registerOrganization(v1, deps);
  for (const def of RESOURCES) registerResource(v1, deps, def);
  registerTeamMembers(v1, deps);
}

function registerOrganization(v1: V1, deps: Deps) {
  const Organization = z
    .object({
      id: z.uuid(),
      name: z.string(),
      code: z.string().nullable(),
      default_timezone: z.string(),
      plan: z.string().nullable(),
      status: z.string(),
      version: z.number().int(),
      updated_at: z.string(),
    })
    .openapi("Organization");
  const COLS = "id, name, code, default_timezone, plan, status, version, updated_at";
  const getRoute = createRoute({
    method: "get",
    path: "/organization",
    tags: ["Organization"],
    summary: "Organisasi pemanggil (dari token)",
    security,
    middleware: guard(deps, "organization.read"),
    responses: { 200: json(ok(Organization), "Organisasi"), ...baseErrors, 404: json(ErrorResponse, "NOT_FOUND") },
  });
  const patchRoute = createRoute({
    method: "patch",
    path: "/organization",
    tags: ["Organization"],
    summary: "Ubah nama dan zona waktu bawaan organisasi",
    security,
    middleware: guard(deps, "organization.manage"),
    request: {
      headers: IfMatch,
      body: {
        content: {
          "application/json": {
            schema: z.object({ name: Name.optional(), default_timezone: Timezone.optional() }).openapi("OrganizationPatch"),
          },
        },
        required: true,
      },
    },
    responses: {
      200: json(ok(Organization), "Organisasi"),
      ...writeErrors,
      412: json(ErrorResponse, "VERSION_CONFLICT"),
    },
  });

  v1.openapi(getRoute, async (c) => {
    const r = await run(c, deps, async (tx) => {
      const res = await tx.query(`select ${COLS} from organization where id = app.current_org()`);
      if (!res.rows[0]) throw new ApiFailure("NOT_FOUND");
      return res.rows[0] as Row;
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("ETag", `"${r.version}"`);
    return c.json({ success: true, data: serialize(r), request_id: c.get("requestId") }, 200);
  });

  v1.openapi(patchRoute, async (c) => {
    const expected = parseIfMatch(c.req.valid("header")["if-match"]);
    const body = c.req.valid("json") as Row;
    const r = await run(c, deps, async (tx) => {
      const org = await tx.query<{ id: string }>("select id from organization where id = app.current_org()");
      const id = org.rows[0]?.id;
      if (!id) throw new ApiFailure("NOT_FOUND");
      return updateRow(tx, "organization", COLS, id, pick(body, ["name", "default_timezone"]), expected);
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    // ORG-API-009 (evaluasi ulang readiness saat zona waktu berubah) menyusul bersama Readiness Engine (M4).
    c.header("ETag", `"${r.version}"`);
    return c.json({ success: true, data: serialize(r), request_id: c.get("requestId") }, 200);
  });
}

function registerResource(v1: V1, deps: Deps, def: ResourceDef) {
  const readGuard = guardAny(deps, [def.readPerm ?? "organization.read", ...(def.readAlso ?? [])], def.readSelfAlso ?? []);
  const manageGuard = guard(deps, def.managePerm ?? "organization.manage");
  const itemPath = `${def.itemBase}/{id}`;
  const IdParam = z.object({ id: z.uuid() });
  const parentParam = def.parent ? z.object({ [def.parent.param]: z.uuid() }) : undefined;

  const listRoute = createRoute({
    method: "get",
    path: def.collectionPath,
    tags: [def.tag],
    summary: `Daftar ${def.label}`,
    security,
    middleware: readGuard,
    request: {
      ...(parentParam ? { params: parentParam } : {}),
      query: z.object({ status: Status.optional() }),
    },
    responses: {
      200: json(list(def.item), `Daftar ${def.label} (master data kecil, tanpa kursor; maksimum ${LIST_LIMIT})`),
      ...baseErrors,
      404: json(ErrorResponse, "NOT_FOUND (induk tidak ada atau di luar scope)"),
      422: json(ErrorResponse, "VALIDATION_ERROR"),
    },
  });
  const createRouteDef = createRoute({
    method: "post",
    path: def.collectionPath,
    tags: [def.tag],
    summary: `Membuat ${def.label}`,
    security,
    middleware: manageGuard,
    request: {
      ...(parentParam ? { params: parentParam } : {}),
      body: { content: { "application/json": { schema: def.create } }, required: true },
    },
    responses: { 201: json(ok(def.item), `${def.label} dibuat`), ...writeErrors },
  });
  const getRoute = createRoute({
    method: "get",
    path: itemPath,
    tags: [def.tag],
    summary: `Detail ${def.label}`,
    security,
    middleware: readGuard,
    request: { params: IdParam },
    responses: { 200: json(ok(def.item), def.label), ...baseErrors, 404: json(ErrorResponse, "NOT_FOUND") },
  });
  const patchRoute = createRoute({
    method: "patch",
    path: itemPath,
    tags: [def.tag],
    summary: `Mengubah ${def.label}`,
    security,
    middleware: manageGuard,
    request: {
      params: IdParam,
      headers: IfMatch,
      body: { content: { "application/json": { schema: def.patch } }, required: true },
    },
    responses: {
      200: json(ok(def.item), def.label),
      ...writeErrors,
      412: json(ErrorResponse, "VERSION_CONFLICT (disertai current_version)"),
    },
  });
  const transitionRoute = (action: "deactivate" | "reactivate") =>
    createRoute({
      method: "post",
      path: `${itemPath}/${action}`,
      tags: [def.tag],
      summary: action === "deactivate" ? `Menonaktifkan ${def.label} (soft delete)` : `Mengaktifkan kembali ${def.label}`,
      security,
      middleware: manageGuard,
      request: {
        params: IdParam,
        headers: z.object({ "if-match": IfMatchValue.optional() }),
      },
      responses: {
        200: json(ok(def.item), def.label),
        ...writeErrors,
        412: json(ErrorResponse, "VERSION_CONFLICT"),
      },
    });

  v1.openapi(listRoute, async (c) => {
    const { status } = c.req.valid("query");
    const parentId = def.parent ? c.req.param(def.parent.param) : undefined;
    const r = await run(c, deps, async (tx) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (def.parent && parentId) {
        const p = await tx.query(`select id from ${def.parent.table} where id = $1`, [parentId]);
        if (!p.rows[0]) throw new ApiFailure("NOT_FOUND");
        params.push(parentId);
        where.push(`${def.parent.param} = $${params.length}`);
      }
      if (status) {
        params.push(status);
        where.push(`status = $${params.length}`);
      }
      const res = await tx.query(
        `select ${def.columns} from ${def.table} ${where.length ? `where ${where.join(" and ")}` : ""}
         order by code, id limit ${LIST_LIMIT + 1}`,
        params,
      );
      return res.rows as Row[];
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    const hasMore = r.length > LIST_LIMIT;
    return c.json(
      {
        success: true,
        data: r.slice(0, LIST_LIMIT).map(serialize),
        pagination: { limit: LIST_LIMIT, next_cursor: null, has_more: hasMore },
        request_id: c.get("requestId"),
      },
      200,
    );
  });

  v1.openapi(createRouteDef, async (c) => {
    const body = { ...(c.req.valid("json") as Row) };
    const parentId = def.parent ? c.req.param(def.parent.param) : undefined;
    const orgId = c.get("identity").organizationId;
    if (!orgId) return respondFailure(c, new ApiFailure("FORBIDDEN"));
    const r = await run(
      c,
      deps,
      async (tx) => {
        const values: Row = { organization_id: orgId, ...pick(body, def.writable) };
        if (def.parent && parentId) {
          const cols = Object.values(def.parent.copy).join(", ");
          const p = await tx.query(`select ${cols} from ${def.parent.table} where id = $1`, [parentId]);
          const prow = p.rows[0] as Row | undefined;
          if (!prow) throw new ApiFailure("NOT_FOUND");
          for (const [target, source] of Object.entries(def.parent.copy)) values[target] = prow[source];
        }
        if (def.prepareCreate) {
          await def.prepareCreate(tx, values, orgId);
        }
        const keys = Object.keys(values);
        const res = await tx.query(
          `insert into ${def.table} (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})
           returning ${def.columns}`,
          keys.map((k) => values[k]),
        );
        return res.rows[0] as Row;
      },
      { inUseIssue: def.inUseIssue },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("ETag", `"${r.version}"`);
    c.header("Location", `/api/v1${def.itemBase}/${r.id}`);
    return c.json({ success: true, data: serialize(r), request_id: c.get("requestId") }, 201);
  });

  v1.openapi(getRoute, async (c) => {
    const { id } = c.req.valid("param");
    const r = await run(c, deps, async (tx) => {
      const res = await tx.query(`select ${def.columns} from ${def.table} where id = $1`, [id]);
      if (!res.rows[0]) throw new ApiFailure("NOT_FOUND");
      return res.rows[0] as Row;
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("ETag", `"${r.version}"`);
    return c.json({ success: true, data: serialize(r), request_id: c.get("requestId") }, 200);
  });

  v1.openapi(patchRoute, async (c) => {
    const { id } = c.req.valid("param");
    const expected = parseIfMatch(c.req.valid("header")["if-match"]);
    const body = c.req.valid("json") as Row;
    const r = await run(c, deps, (tx) => updateRow(tx, def.table, def.columns, id, pick(body, def.writable), expected), {
      inUseIssue: def.inUseIssue,
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("ETag", `"${r.version}"`);
    return c.json({ success: true, data: serialize(r), request_id: c.get("requestId") }, 200);
  });

  for (const action of ["deactivate", "reactivate"] as const) {
    v1.openapi(transitionRoute(action), async (c) => {
      const { id } = c.req.valid("param");
      const expected = parseIfMatch(c.req.valid("header")["if-match"]);
      const target = action === "deactivate" ? "INACTIVE" : "ACTIVE";
      const r = await run(
        c,
        deps,
        async (tx) => {
          const cur = await tx.query<{ status: string }>(`select status from ${def.table} where id = $1`, [id]);
          if (!cur.rows[0]) throw new ApiFailure("NOT_FOUND");
          if (cur.rows[0].status === target) throw new ApiFailure("CONFLICT", [{ field: "status", issue: `already_${target}` }]);
          if (action === "deactivate" && def.affectedSql) {
            // Jumlah yang terlihat pemanggil (RLS); pemicu database tetap menolak bila ada pekerja di luar pandangannya.
            const n = (await tx.query<{ n: number }>(def.affectedSql, [id])).rows[0]?.n ?? 0;
            if (n > 0) throw new ApiFailure("CONFLICT", [{ issue: def.inUseIssue }], { affected_workers: n });
          }
          return updateRow(tx, def.table, def.columns, id, { status: target }, expected);
        },
        { inUseIssue: def.inUseIssue },
      );
      if (r instanceof ApiFailure) return respondFailure(c, r);
      c.header("ETag", `"${r.version}"`);
      return c.json({ success: true, data: serialize(r), request_id: c.get("requestId") }, 200);
    });
  }

  if (def.deletable) {
    const deleteRoute = createRoute({
      method: "delete",
      path: itemPath,
      tags: [def.tag],
      summary: `Menghapus ${def.label} yang belum pernah dipakai (B-28)`,
      security,
      middleware: manageGuard,
      request: { params: IdParam, headers: z.object({ "if-match": IfMatchValue.optional() }) },
      responses: {
        200: json(ok(z.object({ id: z.uuid(), deleted: z.literal(true) })), "Terhapus"),
        ...baseErrors,
        404: json(ErrorResponse, "NOT_FOUND"),
        409: json(ErrorResponse, "MASTER_IN_USE (sudah dipakai; nonaktifkan saja)"),
        412: json(ErrorResponse, "VERSION_CONFLICT"),
      },
    });
    v1.openapi(deleteRoute, async (c) => {
      const { id } = c.req.valid("param");
      const expected = parseIfMatch(c.req.valid("header")["if-match"]);
      const r = await run(
        c,
        deps,
        async (tx) => {
          const cur = await tx.query<{ version: number }>(`select version from ${def.table} where id = $1`, [id]);
          const row = cur.rows[0];
          if (!row) throw new ApiFailure("NOT_FOUND");
          if (expected !== null && expected !== row.version)
            throw new ApiFailure("VERSION_CONFLICT", undefined, { current_version: row.version });
          const del = await tx.query(`delete from ${def.table} where id = $1`, [id]);
          if (del.rowCount === 0) throw new ApiFailure("SCOPE_DENIED");
          return { id, deleted: true as const };
        },
        {
          map: (e: { code?: string }) => (e.code === "23503" ? new ApiFailure("MASTER_IN_USE") : undefined),
        },
      );
      if (r instanceof ApiFailure) return respondFailure(c, r);
      return c.json({ success: true, data: r, request_id: c.get("requestId") }, 200);
    });
  }
}

function registerTeamMembers(v1: V1, deps: Deps) {
  const Member = z
    .object({
      worker_id: z.uuid(),
      full_name: z.string().nullable().openapi({ description: "null bila pemanggil tidak memiliki worker.read atas pekerja" }),
      sho_id: z.string().nullable(),
      valid_from: z.string(),
      valid_until: z.string().nullable(),
      active: z.boolean(),
    })
    .openapi("TeamMember");
  const TeamParam = z.object({ id: z.uuid() });
  const COLS = `tm.worker_id, w.full_name, w.sho_id, tm.valid_from::text as valid_from, tm.valid_until::text as valid_until,
    (tm.valid_from <= current_date and (tm.valid_until is null or tm.valid_until >= current_date)) as active`;

  const listRoute = createRoute({
    method: "get",
    path: "/teams/{id}/members",
    tags: ["Organization"],
    summary: "Anggota team (bertanggal, tidak dihapus)",
    security,
    middleware: guard(deps, "organization.read"),
    request: { params: TeamParam, query: z.object({ include_ended: z.enum(["true", "false"]).optional() }) },
    responses: {
      200: json(list(Member), "Anggota"),
      ...baseErrors,
      404: json(ErrorResponse, "NOT_FOUND"),
      422: json(ErrorResponse, "VALIDATION_ERROR"),
    },
  });
  const addRoute = createRoute({
    method: "post",
    path: "/teams/{id}/members",
    tags: ["Organization"],
    summary: "Menambah anggota team",
    security,
    middleware: guard(deps, "organization.manage"),
    request: {
      params: TeamParam,
      body: {
        content: {
          "application/json": { schema: z.object({ worker_id: z.uuid(), valid_from: IsoDate }).openapi("TeamMemberAdd") },
        },
        required: true,
      },
    },
    responses: { 201: json(ok(Member), "Anggota ditambahkan"), ...writeErrors },
  });
  const endRoute = createRoute({
    method: "post",
    path: "/teams/{id}/members/{worker_id}/end",
    tags: ["Organization"],
    summary: "Mengakhiri keanggotaan team",
    security,
    middleware: guard(deps, "organization.manage"),
    request: {
      params: z.object({ id: z.uuid(), worker_id: z.uuid() }),
      body: {
        content: { "application/json": { schema: z.object({ valid_until: IsoDate }).openapi("TeamMemberEnd") } },
        required: true,
      },
    },
    responses: { 200: json(ok(Member), "Keanggotaan diakhiri"), ...writeErrors },
  });

  const teamVisible = async (tx: Tx, id: string) => {
    const t = await tx.query<{ status: string }>("select status from team where id = $1", [id]);
    if (!t.rows[0]) throw new ApiFailure("NOT_FOUND");
    return t.rows[0].status;
  };

  v1.openapi(listRoute, async (c) => {
    const { id } = c.req.valid("param");
    const includeEnded = c.req.valid("query").include_ended === "true";
    const r = await run(c, deps, async (tx) => {
      await teamVisible(tx, id);
      const res = await tx.query(
        `select ${COLS} from team_member tm left join worker w on w.id = tm.worker_id
         where tm.team_id = $1 ${includeEnded ? "" : "and (tm.valid_until is null or tm.valid_until >= current_date)"}
         order by w.full_name nulls last, tm.valid_from limit ${LIST_LIMIT + 1}`,
        [id],
      );
      return res.rows as Row[];
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return c.json(
      {
        success: true,
        data: r.slice(0, LIST_LIMIT).map(serialize),
        pagination: { limit: LIST_LIMIT, next_cursor: null, has_more: r.length > LIST_LIMIT },
        request_id: c.get("requestId"),
      },
      200,
    );
  });

  v1.openapi(addRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const orgId = c.get("identity").organizationId;
    if (!orgId) return respondFailure(c, new ApiFailure("FORBIDDEN"));
    const r = await run(c, deps, async (tx) => {
      if ((await teamVisible(tx, id)) !== "ACTIVE") throw new ApiFailure("CONFLICT", [{ issue: "TEAM_INACTIVE" }]);
      const ins = await tx.query<{ id: string }>(
        "insert into team_member (organization_id, team_id, worker_id, valid_from) values ($1, $2, $3, $4) returning id",
        [orgId, id, body.worker_id, body.valid_from],
      );
      const res = await tx.query(
        `select ${COLS} from team_member tm left join worker w on w.id = tm.worker_id where tm.id = $1`,
        [ins.rows[0]?.id],
      );
      return res.rows[0] as Row;
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return c.json({ success: true, data: serialize(r), request_id: c.get("requestId") }, 201);
  });

  v1.openapi(endRoute, async (c) => {
    const { id, worker_id } = c.req.valid("param");
    const { valid_until } = c.req.valid("json");
    const r = await run(c, deps, async (tx) => {
      await teamVisible(tx, id);
      const cur = await tx.query<{ id: string }>(
        "select id from team_member where team_id = $1 and worker_id = $2 and valid_until is null",
        [id, worker_id],
      );
      const memberId = cur.rows[0]?.id;
      if (!memberId) throw new ApiFailure("NOT_FOUND");
      const upd = await tx.query("update team_member set valid_until = $2 where id = $1", [memberId, valid_until]);
      if (upd.rowCount === 0) throw new ApiFailure("SCOPE_DENIED");
      const res = await tx.query(
        `select ${COLS} from team_member tm left join worker w on w.id = tm.worker_id where tm.id = $1`,
        [memberId],
      );
      return res.rows[0] as Row;
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return c.json({ success: true, data: serialize(r), request_id: c.get("requestId") }, 200);
  });
}

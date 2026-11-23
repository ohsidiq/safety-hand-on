import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db, Tx } from "@soh/db";
import { withUser } from "@soh/db";
import type { Context, MiddlewareHandler } from "hono";
import { type AuthEnv, type AuthVerifier, authenticate, requirePermission } from "./auth.js";
import { type ErrorCode, type ErrorDetail, errorBody, errorStatus } from "./errors.js";

/**
 * Struktur organisasi (API-002 §3-§6, §8-§11): organisasi sendiri, Site, Department, Division, Team (dan anggota),
 * Job Position, Equipment Class.
 * - Organisasi pemanggil dari token; tidak ada id organisasi pada URL (§3). Objek di luar organisasi/scope -> 404 (ORG-API-007).
 * - Tidak ada penghapusan; penonaktifan lewat aksi deactivate (ORG-API-003). Struktur berpekerja aktif ditolak (ORG-API-004).
 * - PATCH wajib If-Match: <version> (API-000 §10). Audit dicatat pemicu database (ORG-API-010).
 * - Semua kueri lewat withUser (ARCH-002); RLS menegakkan scope Site.
 * Belum di M2.3: area platform /platform/tenants, /organization/settings (configuration.manage), evaluasi ulang readiness
 * saat timezone/posisi berubah (ORG-API-009, menunggu Readiness Engine M4), Contractor (API-003 §11a, M2.4/M2.5).
 */

type Deps = { auth?: AuthVerifier | undefined; db?: Db | undefined };
type Ctx = Context<AuthEnv>;
type Row = Record<string, unknown>;

// ---------------------------------------------------------------- skema bersama

const ErrorResponse = z
  .object({
    success: z.literal(false),
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.array(z.object({ field: z.string().optional(), issue: z.string() })).optional(),
    }),
    request_id: z.string(),
  })
  .openapi("OrgErrorResponse");

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

const json = (schema: z.ZodType, description: string) => ({ content: { "application/json": { schema } }, description });
const ok = (data: z.ZodType) => z.object({ success: z.literal(true), data, request_id: z.string() });
const list = (item: z.ZodType) =>
  z.object({
    success: z.literal(true),
    data: z.array(item),
    pagination: z.object({ limit: z.number(), next_cursor: z.string().nullable(), has_more: z.boolean() }),
    request_id: z.string(),
  });
const security = [{ bearerAuth: [] }];
const baseErrors = {
  401: json(ErrorResponse, "UNAUTHORIZED atau TOKEN_EXPIRED"),
  403: json(ErrorResponse, "FORBIDDEN, SCOPE_DENIED atau ACCOUNT_DEACTIVATED"),
};
const writeErrors = {
  ...baseErrors,
  404: json(ErrorResponse, "NOT_FOUND (tidak ada atau di luar organisasi/scope)"),
  409: json(ErrorResponse, "DUPLICATE (kode sudah dipakai) atau CONFLICT (masih dipakai pekerja aktif)"),
  422: json(ErrorResponse, "VALIDATION_ERROR"),
};
const IF_MATCH_RE = /^(?:W\/)?"?\d{1,9}"?$/;
const IfMatchValue = z
  .string()
  .regex(IF_MATCH_RE)
  .openapi({ description: "Versi terakhir yang dibaca (API-000 §10). Tidak ada/rusak -> 422", example: '"3"' });
const IfMatch = z.object({ "if-match": IfMatchValue });
const LIST_LIMIT = 500;

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
];

// ---------------------------------------------------------------- utilitas

class ApiFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly details?: ErrorDetail[],
    readonly extra?: Row,
  ) {
    super(code);
  }
}

function serialize(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[k] = v instanceof Date ? v.toISOString() : v;
  return out;
}

/** If-Match: "3", 3, W/"3". Kosong/rusak -> null. */
export function parseIfMatch(header: string | undefined): number | null {
  const m = /^(?:W\/)?"?(\d{1,9})"?$/.exec((header ?? "").trim());
  return m ? Number(m[1]) : null;
}

/** Galat PostgreSQL -> kode API-000. Galat lain dilempar ulang (500 tanpa detail). */
export function mapPgError(err: unknown, inUseIssue = "ACTIVE_WORKERS_EXIST"): ApiFailure {
  if (err instanceof ApiFailure) return err;
  const e = err as { code?: string; message?: string; constraint?: string };
  const msg = e.message ?? "";
  switch (e.code) {
    case "23505":
      return new ApiFailure("DUPLICATE", [{ field: "code", issue: "already_used" }]);
    case "23P01":
      return new ApiFailure("CONFLICT", [{ field: "valid_from", issue: "MEMBERSHIP_OVERLAP" }]);
    case "23503":
      return new ApiFailure("VALIDATION_ERROR", [{ issue: "reference_not_found" }]);
    case "23514":
      if (msg.startsWith("INVALID_TIMEZONE"))
        return new ApiFailure("VALIDATION_ERROR", [{ field: "timezone", issue: "invalid_iana" }]);
      if (msg.startsWith("ACTIVE_WORKERS_EXIST")) return new ApiFailure("CONFLICT", [{ issue: inUseIssue }]);
      if (msg.startsWith("WORKER_SITE_MISMATCH"))
        return new ApiFailure("VALIDATION_ERROR", [{ field: "worker_id", issue: "WORKER_SITE_MISMATCH" }]);
      if (e.constraint === "team_member_range_chk")
        return new ApiFailure("VALIDATION_ERROR", [{ field: "valid_until", issue: "must_be_on_or_after_valid_from" }]);
      return new ApiFailure("VALIDATION_ERROR");
    case "22007":
    case "22008":
      return new ApiFailure("VALIDATION_ERROR", [{ issue: "invalid_date" }]);
    case "42501":
      // permission ada, tetapi RLS menolak baris baru: di luar scope
      return new ApiFailure("SCOPE_DENIED");
    default:
      throw err;
  }
}

/** Respons galat. Status dinamis dari katalog; kontrak per rute didokumentasikan di `responses` (cast untuk pemeriksa tipe). */
function respondFailure(c: Ctx, f: ApiFailure): never {
  const body = errorBody(f.code, c.get("requestId"), f.details);
  return c.json(f.extra ? { ...body, error: { ...body.error, ...f.extra } } : body, errorStatus[f.code]) as never;
}

async function run<T>(c: Ctx, deps: Deps, fn: (tx: Tx) => Promise<T>, inUseIssue?: string): Promise<T | ApiFailure> {
  const identity = c.get("identity");
  try {
    return await withUser(deps.db as Db, identity.userId, fn, identity.ctx);
  } catch (err) {
    return mapPgError(err, inUseIssue);
  }
}

const guard = (deps: Deps, permission: string): MiddlewareHandler<AuthEnv>[] => [
  authenticate(deps),
  requirePermission(permission),
];

/** Memperbarui satu baris dengan pemeriksaan keberadaan (404), versi (412), dan scope tulis (403). */
async function updateRow(tx: Tx, table: string, columns: string, id: string, set: Row, expected: number | null): Promise<Row> {
  const cur = await tx.query<{ version: number }>(`select version from ${table} where id = $1`, [id]);
  const row = cur.rows[0];
  if (!row) throw new ApiFailure("NOT_FOUND");
  if (expected !== null && expected !== row.version) {
    throw new ApiFailure("VERSION_CONFLICT", undefined, { current_version: row.version });
  }
  const keys = Object.keys(set);
  if (keys.length === 0) {
    const same = await tx.query(`select ${columns} from ${table} where id = $1`, [id]);
    return same.rows[0] as Row;
  }
  const assigns = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  const res = await tx.query(`update ${table} set ${assigns} where id = $1 returning ${columns}`, [
    id,
    ...keys.map((k) => set[k]),
  ]);
  // terlihat (baca) tetapi kebijakan tulis menolak: permission ada, di luar scope tulis
  if (res.rowCount === 0) throw new ApiFailure("SCOPE_DENIED");
  return res.rows[0] as Row;
}

function pick(body: Row, keys: string[]): Row {
  const out: Row = {};
  for (const k of keys) if (body[k] !== undefined) out[k] = body[k];
  return out;
}

// ---------------------------------------------------------------- pendaftaran

export function registerOrgStructure(v1: OpenAPIHono<AuthEnv>, deps: Deps) {
  registerOrganization(v1, deps);
  for (const def of RESOURCES) registerResource(v1, deps, def);
  registerTeamMembers(v1, deps);
}

function registerOrganization(v1: OpenAPIHono<AuthEnv>, deps: Deps) {
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

function registerResource(v1: OpenAPIHono<AuthEnv>, deps: Deps, def: ResourceDef) {
  const itemPath = `${def.itemBase}/{id}`;
  const IdParam = z.object({ id: z.uuid() });
  const parentParam = def.parent ? z.object({ [def.parent.param]: z.uuid() }) : undefined;

  const listRoute = createRoute({
    method: "get",
    path: def.collectionPath,
    tags: [def.tag],
    summary: `Daftar ${def.label}`,
    security,
    middleware: guard(deps, "organization.read"),
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
    middleware: guard(deps, "organization.manage"),
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
    middleware: guard(deps, "organization.read"),
    request: { params: IdParam },
    responses: { 200: json(ok(def.item), def.label), ...baseErrors, 404: json(ErrorResponse, "NOT_FOUND") },
  });
  const patchRoute = createRoute({
    method: "patch",
    path: itemPath,
    tags: [def.tag],
    summary: `Mengubah ${def.label}`,
    security,
    middleware: guard(deps, "organization.manage"),
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
      middleware: guard(deps, "organization.manage"),
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
      def.inUseIssue,
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
    const r = await run(
      c,
      deps,
      (tx) => updateRow(tx, def.table, def.columns, id, pick(body, def.writable), expected),
      def.inUseIssue,
    );
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
        def.inUseIssue,
      );
      if (r instanceof ApiFailure) return respondFailure(c, r);
      c.header("ETag", `"${r.version}"`);
      return c.json({ success: true, data: serialize(r), request_id: c.get("requestId") }, 200);
    });
  }
}

function registerTeamMembers(v1: OpenAPIHono<AuthEnv>, deps: Deps) {
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

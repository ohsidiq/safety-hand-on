import { createRoute, z } from "@hono/zod-openapi";
import type { Tx } from "@soh/db";
import { authenticate } from "./auth.js";
import { type NationalIdCrypto, normalizeNationalId } from "./national-id.js";
import {
  ApiFailure,
  baseErrors,
  type Ctx,
  type Deps,
  ErrorResponse,
  guard,
  IfMatch,
  IfMatchValue,
  json,
  LIST_LIMIT,
  list,
  ok,
  parseIfMatch,
  type Row,
  type RunOptions,
  respondFailure,
  run,
  security,
  serialize,
  updateRow,
  type V1,
  writeErrors,
} from "./route-kit.js";

/**
 * Pekerja (API-003 §2-§4, §7-§10) dan daftar kontraktor untuk pemilih (API-002 §7, B-23).
 * - Organisasi dari token (WF-API-002). Tanpa DELETE; status lewat aksi beralasan (WF-API-006).
 * - NIK hanya-tulis: disandi di Core API, respons hanya has_national_id (WF-API-005).
 * - Site/Department/Division/Job Position hanya lewat penempatan berriwayat (WF-API-007).
 * - Semua kueri lewat withUser (ARCH-002); RLS menegakkan scope Site/Tim; di luar scope -> 404.
 * Belum di M2.4: evaluasi readiness saat dibuat/berubah (WF-API-008, Readiness Engine M4), kontak darurat dan foto
 * (alur file), impor/ekspor (M2.5), Idempotency-Key, penempatan bertanggal mendatang (butuh job terjadwal),
 * ubah data diri oleh pekerja (permission S).
 */

export type WorkerDeps = Deps & { nationalId?: NationalIdCrypto | undefined };

// ---------------------------------------------------------------- skema

const EmploymentStatus = z.enum(["PERMANENT", "CONTRACT", "CONTRACTOR"]);
const WorkerStatus = z.enum(["ACTIVE", "INACTIVE", "SUSPENDED", "RESIGNED"]);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const EmployeeNumber = z
  .string()
  .trim()
  .min(3)
  .max(30)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
const FullName = z.string().trim().min(2).max(150);
const Phone = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/)
  .openapi({ description: "Format E.164", example: "+6281200000000" });
const Email = z.email().max(254);
const NationalId = z.string().max(32).openapi({ description: "NIK 16 digit. Hanya-tulis: tidak pernah dikembalikan" });
const Ref = z.object({ id: z.uuid(), name: z.string().nullable() }).nullable();

const WorkerSummary = z
  .object({
    id: z.uuid(),
    sho_id: z.string(),
    employee_number: z.string(),
    full_name: z.string(),
    employment_status: EmploymentStatus,
    worker_status: WorkerStatus,
    join_date: z.string(),
    site: Ref,
    department: Ref,
    division: Ref,
    job_position: Ref,
    contractor: Ref,
    version: z.number().int(),
  })
  .openapi("WorkerSummary");

const Worker = WorkerSummary.extend({
  phone: z.string().nullable(),
  email: z.string().nullable(),
  has_national_id: z.boolean(),
  has_account: z.boolean(),
  exit_date: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("Worker");

const Assignment = z
  .object({
    id: z.uuid(),
    site: Ref,
    department: Ref,
    division: Ref,
    job_position: Ref,
    effective_from: z.string(),
    effective_until: z.string().nullable(),
    current: z.boolean(),
    reason: z.string(),
    created_at: z.string(),
  })
  .openapi("WorkerAssignment");

const Contractor = z
  .object({
    id: z.uuid(),
    code: z.string(),
    name: z.string(),
    status: z.enum(["ACTIVE", "INACTIVE"]),
    site_ids: z.array(z.uuid()).openapi({ description: "Site terhubung yang berlaku (ER-013)" }),
  })
  .openapi("ContractorOption");

const WorkerCreate = z
  .object({
    employee_number: EmployeeNumber,
    full_name: FullName,
    phone: Phone.nullable().optional(),
    email: Email.nullable().optional(),
    national_id: NationalId.nullable().optional(),
    employment_status: EmploymentStatus,
    join_date: IsoDate,
    site_id: z.uuid(),
    department_id: z.uuid(),
    division_id: z.uuid().nullable().optional(),
    job_position_id: z.uuid(),
    contractor_id: z.uuid().nullable().optional(),
  })
  .openapi("WorkerCreate");

const WorkerPatch = z
  .object({
    full_name: FullName.optional(),
    phone: Phone.nullable().optional(),
    email: Email.nullable().optional(),
    national_id: NationalId.nullable().optional(),
    employment_status: EmploymentStatus.optional(),
    contractor_id: z.uuid().nullable().optional(),
  })
  .openapi("WorkerPatch");

const StatusAction = z
  .object({
    reason: z.string().max(500).optional().openapi({ description: "Wajib, 3-500 karakter (REASON_REQUIRED)" }),
    effective_date: IsoDate.optional(),
    exit_date: IsoDate.optional().openapi({ description: "Wajib untuk resign" }),
  })
  .openapi("WorkerStatusAction");

const AssignmentCreate = z
  .object({
    site_id: z.uuid(),
    department_id: z.uuid(),
    division_id: z.uuid().nullable().optional(),
    job_position_id: z.uuid(),
    effective_from: IsoDate,
    reason: z.string().max(200).optional().openapi({ description: "Wajib, 3-200 karakter (REASON_REQUIRED)" }),
  })
  .openapi("WorkerAssignmentCreate");

const workerErrors = {
  ...writeErrors,
  409: json(ErrorResponse, "DUPLICATE, INVALID_STATE_TRANSITION, ASSIGNMENT_OVERLAP"),
  412: json(ErrorResponse, "VERSION_CONFLICT (disertai current_version)"),
  422: json(
    ErrorResponse,
    "VALIDATION_ERROR, DEPARTMENT_NOT_IN_SITE, CONTRACTOR_REQUIRED, CONTRACTOR_NOT_ALLOWED, REASON_REQUIRED, SITE_NOT_LINKED_TO_CONTRACTOR",
  ),
  503: json(ErrorResponse, "SERVICE_UNAVAILABLE (penyimpanan NIK belum dikonfigurasi)"),
};

// ---------------------------------------------------------------- SQL

const SELECT_SUMMARY = `
  select w.id, w.sho_id, w.employee_number, w.full_name, w.employment_status, w.worker_status, w.join_date::text as join_date,
         w.site_id, s.name as site_name, w.department_id, d.name as department_name, w.division_id, dv.name as division_name,
         w.job_position_id, jp.name as job_position_name, w.contractor_id, c.name as contractor_name, w.version`;
const SELECT_DETAIL = `${SELECT_SUMMARY},
         w.phone, w.email, w.has_national_id, (w.user_id is not null) as has_account, w.exit_date::text as exit_date,
         w.created_at, w.updated_at`;
const FROM = `
  from worker w
  left join site s on s.id = w.site_id
  left join department d on d.id = w.department_id
  left join division dv on dv.id = w.division_id
  left join job_position jp on jp.id = w.job_position_id
  left join contractor c on c.id = w.contractor_id`;

const ref = (id: unknown, name: unknown) => (id ? { id: id as string, name: (name as string | null) ?? null } : null);

function toWorker(r: Row): Row {
  const out: Row = {
    id: r.id,
    sho_id: r.sho_id,
    employee_number: r.employee_number,
    full_name: r.full_name,
    employment_status: r.employment_status,
    worker_status: r.worker_status,
    join_date: r.join_date,
    site: ref(r.site_id, r.site_name),
    department: ref(r.department_id, r.department_name),
    division: ref(r.division_id, r.division_name),
    job_position: ref(r.job_position_id, r.job_position_name),
    contractor: ref(r.contractor_id, r.contractor_name),
    version: r.version,
  };
  if ("has_national_id" in r) {
    Object.assign(out, {
      phone: r.phone ?? null,
      email: r.email ?? null,
      has_national_id: r.has_national_id,
      has_account: r.has_account,
      exit_date: r.exit_date ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at,
    });
  }
  return serialize(out);
}

async function loadWorker(tx: Tx, where: string, params: unknown[]): Promise<Row> {
  const res = await tx.query(`${SELECT_DETAIL} ${FROM} where w.deleted_at is null and ${where}`, params);
  const row = res.rows[0] as Row | undefined;
  if (!row) throw new ApiFailure("NOT_FOUND");
  return toWorker(row);
}

/** Galat database khusus pekerja (API-003 §10). */
function mapWorkerError(e: { code?: string; message?: string; constraint?: string }): ApiFailure | undefined {
  const c = e.constraint ?? "";
  const msg = e.message ?? "";
  if (e.code === "23505") {
    if (c === "worker_nik_hash_uq") return new ApiFailure("DUPLICATE", [{ field: "national_id", issue: "already_used" }]);
    if (c === "worker_employee_number_uq")
      return new ApiFailure("DUPLICATE", [{ field: "employee_number", issue: "already_used" }]);
  }
  if (e.code === "23P01" || c === "worker_assignment_range_chk") return new ApiFailure("ASSIGNMENT_OVERLAP");
  if (e.code === "23503") {
    if (c.includes("department_id_site_id"))
      return new ApiFailure("DEPARTMENT_NOT_IN_SITE", [{ field: "department_id", issue: "not_in_site" }]);
    if (c.includes("division_id_department_id"))
      return new ApiFailure("VALIDATION_ERROR", [{ field: "division_id", issue: "not_in_department" }]);
    for (const f of ["job_position_id", "contractor_id", "site_id"]) {
      if (c.includes(f)) return new ApiFailure("VALIDATION_ERROR", [{ field: f, issue: "reference_not_found" }]);
    }
  }
  if (e.code === "23514") {
    if (msg.startsWith("CONTRACTOR_SITE_NOT_LINKED"))
      return new ApiFailure("SITE_NOT_LINKED_TO_CONTRACTOR", [{ field: "site_id", issue: "not_linked" }]);
    if (c === "worker_contractor_er012")
      return new ApiFailure("CONTRACTOR_REQUIRED", [{ field: "contractor_id", issue: "required" }]);
    if (c === "worker_exit_chk" || c === "worker_resigned_exit_chk")
      return new ApiFailure("VALIDATION_ERROR", [{ field: "exit_date", issue: "must_be_on_or_after_join_date" }]);
    if (c === "worker_employee_number_chk")
      return new ApiFailure("VALIDATION_ERROR", [{ field: "employee_number", issue: "invalid" }]);
    if (msg.startsWith("SHO_ID_IMMUTABLE")) return new ApiFailure("VALIDATION_ERROR", [{ field: "sho_id", issue: "immutable" }]);
  }
  return undefined;
}

const wopts = (extra: Partial<RunOptions> = {}): RunOptions => ({ map: mapWorkerError, ...extra });

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** ER-012 di API: kode galat spesifik sebelum menyentuh database (API-003 §10). */
function checkContractor(status: string, contractorId: string | null | undefined): ApiFailure | null {
  if (status === "CONTRACTOR" && !contractorId)
    return new ApiFailure("CONTRACTOR_REQUIRED", [{ field: "contractor_id", issue: "required" }]);
  if (status !== "CONTRACTOR" && contractorId)
    return new ApiFailure("CONTRACTOR_NOT_ALLOWED", [{ field: "contractor_id", issue: "not_allowed" }]);
  return null;
}

/** Site, department, posisi (dan divisi) harus terlihat dan aktif. */
async function checkPlacement(
  tx: Tx,
  b: { site_id: string; department_id: string; division_id?: string | null; job_position_id: string },
) {
  const r = await tx.query<{
    site: string | null;
    dep: string | null;
    dep_site: string | null;
    pos: string | null;
    div: string | null;
    div_dep: string | null;
  }>(
    `select (select status from site where id = $1) as site,
            (select status from department where id = $2) as dep,
            (select site_id::text from department where id = $2) as dep_site,
            (select status from job_position where id = $3) as pos,
            (select status from division where id = $4) as div,
            (select department_id::text from division where id = $4) as div_dep`,
    [b.site_id, b.department_id, b.job_position_id, b.division_id ?? null],
  );
  const x = r.rows[0];
  if (!x?.site) throw new ApiFailure("VALIDATION_ERROR", [{ field: "site_id", issue: "reference_not_found" }]);
  if (!x.dep) throw new ApiFailure("VALIDATION_ERROR", [{ field: "department_id", issue: "reference_not_found" }]);
  if (x.dep_site !== b.site_id)
    throw new ApiFailure("DEPARTMENT_NOT_IN_SITE", [{ field: "department_id", issue: "not_in_site" }]);
  if (!x.pos) throw new ApiFailure("VALIDATION_ERROR", [{ field: "job_position_id", issue: "reference_not_found" }]);
  if (b.division_id && x.div_dep !== b.department_id)
    throw new ApiFailure("VALIDATION_ERROR", [{ field: "division_id", issue: "not_in_department" }]);
  for (const [field, status] of [
    ["site_id", x.site],
    ["department_id", x.dep],
    ["job_position_id", x.pos],
    ["division_id", b.division_id ? x.div : "ACTIVE"],
  ] as const) {
    if (status !== "ACTIVE") throw new ApiFailure("VALIDATION_ERROR", [{ field, issue: "inactive" }]);
  }
}

function sealNik(deps: WorkerDeps, orgId: string, value: string | null | undefined): Row | ApiFailure {
  if (value === undefined) return {};
  if (value === null) return { national_id_encrypted: null, national_id_hash: null };
  const nik = normalizeNationalId(value);
  if (!nik) return new ApiFailure("VALIDATION_ERROR", [{ field: "national_id", issue: "must_be_16_digits" }]);
  if (!deps.nationalId) return new ApiFailure("SERVICE_UNAVAILABLE", [{ field: "national_id", issue: "not_configured" }]);
  const { encrypted, hash } = deps.nationalId.seal(orgId, nik);
  return { national_id_encrypted: encrypted, national_id_hash: hash };
}

function decodeCursor(cursor: string): { n: string; id: string } | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { n?: unknown; id?: unknown };
    if (typeof v.n !== "string" || typeof v.id !== "string" || !z.uuid().safeParse(v.id).success) return null;
    return { n: v.n, id: v.id };
  } catch {
    return null;
  }
}

/** Respons pekerja dengan ETag versi. Status 200/201 sesuai rute (cast untuk pemeriksa tipe; kontrak di `responses`). */
function respondWorker(c: Ctx, data: Row, status: 200 | 201 = 200): never {
  c.header("ETag", `"${data.version}"`);
  return c.json({ success: true as const, data, request_id: c.get("requestId") }, status) as never;
}

// ---------------------------------------------------------------- rute

export function registerWorkers(v1: V1, deps: WorkerDeps) {
  const IdParam = z.object({ id: z.uuid() });

  const listRoute = createRoute({
    method: "get",
    path: "/workers",
    tags: ["Workers"],
    summary: "Daftar pekerja dalam scope pemanggil (kursor)",
    security,
    middleware: guard(deps, "worker.read"),
    request: {
      query: z.object({
        site_id: z.uuid().optional(),
        department_id: z.uuid().optional(),
        division_id: z.uuid().optional(),
        team_id: z.uuid().optional(),
        job_position_id: z.uuid().optional(),
        contractor_id: z.uuid().optional(),
        worker_status: WorkerStatus.optional(),
        employment_status: EmploymentStatus.optional(),
        q: z.string().trim().min(1).max(100).optional().openapi({ description: "Nama, nomor pekerja, atau SHO ID" }),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        cursor: z.string().max(400).optional(),
      }),
    },
    responses: {
      200: json(
        z.object({
          success: z.literal(true),
          data: z.array(WorkerSummary),
          pagination: z.object({ limit: z.number(), next_cursor: z.string().nullable(), has_more: z.boolean() }),
          request_id: z.string(),
        }),
        "Daftar pekerja (urut nama). Status kesiapan tidak dimuat (API-014)",
      ),
      ...baseErrors,
      422: json(ErrorResponse, "VALIDATION_ERROR"),
    },
  });

  const meRoute = createRoute({
    method: "get",
    path: "/workers/me",
    tags: ["Workers"],
    summary: "Data pekerja milik akun pemanggil (B-18, WF-API-010)",
    security,
    middleware: [authenticate(deps)],
    responses: { 200: json(ok(Worker), "Pekerja"), ...baseErrors, 404: json(ErrorResponse, "Akun tidak terhubung ke pekerja") },
  });

  const dupRoute = createRoute({
    method: "get",
    path: "/workers/duplicate-check",
    tags: ["Workers"],
    summary: "Apakah nomor pekerja sudah dipakai di organisasi (tanpa data pekerja)",
    security,
    middleware: guard(deps, "worker.create"),
    request: { query: z.object({ employee_number: EmployeeNumber }) },
    responses: {
      200: json(ok(z.object({ exists: z.boolean() })), "Hasil"),
      ...baseErrors,
      422: json(ErrorResponse, "VALIDATION_ERROR"),
    },
  });

  const getRoute = createRoute({
    method: "get",
    path: "/workers/{id}",
    tags: ["Workers"],
    summary: "Detail pekerja (tanpa NIK)",
    security,
    middleware: guard(deps, "worker.read"),
    request: { params: IdParam },
    responses: {
      200: json(ok(Worker), "Pekerja"),
      ...baseErrors,
      404: json(ErrorResponse, "NOT_FOUND (tidak ada atau di luar scope)"),
    },
  });

  const createWorkerRoute = createRoute({
    method: "post",
    path: "/workers",
    tags: ["Workers"],
    summary: "Membuat pekerja (SHO ID dibuat sistem, penempatan awal otomatis)",
    security,
    middleware: guard(deps, "worker.create"),
    request: { body: { content: { "application/json": { schema: WorkerCreate } }, required: true } },
    responses: { 201: json(ok(Worker), "Pekerja dibuat"), ...workerErrors },
  });

  const patchRoute = createRoute({
    method: "patch",
    path: "/workers/{id}",
    tags: ["Workers"],
    summary: "Mengubah data pekerja (bukan penempatan, bukan status)",
    security,
    middleware: guard(deps, "worker.update"),
    request: {
      params: IdParam,
      headers: IfMatch,
      body: { content: { "application/json": { schema: WorkerPatch } }, required: true },
    },
    responses: { 200: json(ok(Worker), "Pekerja"), ...workerErrors },
  });

  const TRANSITIONS = {
    suspend: { from: ["ACTIVE"], to: "SUSPENDED" },
    reinstate: { from: ["SUSPENDED"], to: "ACTIVE" },
    deactivate: { from: ["ACTIVE", "SUSPENDED"], to: "INACTIVE" },
    reactivate: { from: ["INACTIVE"], to: "ACTIVE" },
    resign: { from: ["ACTIVE", "SUSPENDED", "INACTIVE"], to: "RESIGNED" },
  } as const;

  const statusRoute = (action: keyof typeof TRANSITIONS) =>
    createRoute({
      method: "post",
      path: `/workers/{id}/${action}`,
      tags: ["Workers"],
      summary: `Aksi status: ${action} (${TRANSITIONS[action].from.join("/")} ke ${TRANSITIONS[action].to}), alasan wajib`,
      security,
      middleware: guard(deps, "worker.deactivate"),
      request: {
        params: IdParam,
        headers: z.object({ "if-match": IfMatchValue.optional() }),
        body: { content: { "application/json": { schema: StatusAction } }, required: true },
      },
      responses: { 200: json(ok(Worker), "Pekerja"), ...workerErrors },
    });

  const assignmentsRoute = createRoute({
    method: "get",
    path: "/workers/{id}/assignments",
    tags: ["Workers"],
    summary: "Riwayat penempatan",
    security,
    middleware: guard(deps, "worker.read"),
    request: { params: IdParam },
    responses: { 200: json(list(Assignment), "Riwayat (terbaru dulu)"), ...baseErrors, 404: json(ErrorResponse, "NOT_FOUND") },
  });

  const assignRoute = createRoute({
    method: "post",
    path: "/workers/{id}/assignments",
    tags: ["Workers"],
    summary: "Penempatan baru (mutasi Site/department/posisi); menutup penempatan sebelumnya",
    security,
    middleware: guard(deps, "worker.update"),
    request: { params: IdParam, body: { content: { "application/json": { schema: AssignmentCreate } }, required: true } },
    responses: { 201: json(ok(Worker), "Pekerja dengan penempatan terbaru"), ...workerErrors },
  });

  const contractorsRoute = createRoute({
    method: "get",
    path: "/contractors",
    tags: ["Contractors"],
    summary: "Daftar kontraktor untuk pemilih (data induk P0, B-23). Pengelolaan penuh P2",
    security,
    middleware: guard(deps, "contractor.read"),
    request: { query: z.object({ status: z.enum(["ACTIVE", "INACTIVE"]).optional() }) },
    responses: { 200: json(list(Contractor), "Kontraktor"), ...baseErrors, 422: json(ErrorResponse, "VALIDATION_ERROR") },
  });

  // --- daftar
  v1.openapi(listRoute, async (c) => {
    const q = c.req.valid("query");
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    if (q.cursor && !cursor)
      return respondFailure(c, new ApiFailure("VALIDATION_ERROR", [{ field: "cursor", issue: "invalid" }]));
    const limit = q.limit ?? 50;
    const r = await run(c, deps, async (tx) => {
      const where = ["w.deleted_at is null"];
      const params: unknown[] = [];
      const add = (sql: string, v: unknown) => {
        params.push(v);
        where.push(sql.replace("?", `$${params.length}`));
      };
      if (q.site_id) add("w.site_id = ?", q.site_id);
      if (q.department_id) add("w.department_id = ?", q.department_id);
      if (q.division_id) add("w.division_id = ?", q.division_id);
      if (q.job_position_id) add("w.job_position_id = ?", q.job_position_id);
      if (q.contractor_id) add("w.contractor_id = ?", q.contractor_id);
      if (q.worker_status) add("w.worker_status = ?", q.worker_status);
      if (q.employment_status) add("w.employment_status = ?", q.employment_status);
      if (q.team_id)
        add(
          "exists (select 1 from team_member tm where tm.worker_id = w.id and tm.team_id = ? and tm.valid_from <= current_date and (tm.valid_until is null or tm.valid_until >= current_date))",
          q.team_id,
        );
      if (q.q) {
        const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
        add("(w.full_name ilike ? or w.employee_number ilike $X or w.sho_id ilike $X)", like);
        where[where.length - 1] = (where[where.length - 1] as string).replaceAll("$X", `$${params.length}`);
      }
      if (cursor) {
        params.push(cursor.n, cursor.id);
        where.push(`(w.full_name, w.id) > ($${params.length - 1}, $${params.length})`);
      }
      const res = await tx.query(
        `${SELECT_SUMMARY} ${FROM} where ${where.join(" and ")} order by w.full_name, w.id limit ${limit + 1}`,
        params,
      );
      return res.rows as Row[];
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    const page = r.slice(0, limit);
    const last = page[page.length - 1];
    const hasMore = r.length > limit;
    return c.json(
      {
        success: true,
        data: page.map(toWorker),
        pagination: {
          limit,
          next_cursor:
            hasMore && last ? Buffer.from(JSON.stringify({ n: last.full_name, id: last.id })).toString("base64url") : null,
          has_more: hasMore,
        },
        request_id: c.get("requestId"),
      },
      200,
    );
  });

  // --- data diri (didaftarkan sebelum /workers/{id})
  v1.openapi(meRoute, async (c) => {
    const r = await run(c, deps, (tx) => loadWorker(tx, "w.id = app.my_worker_id()", []));
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return respondWorker(c, r);
  });

  v1.openapi(dupRoute, async (c) => {
    const { employee_number } = c.req.valid("query");
    const r = await run(c, deps, async (tx) => {
      const res = await tx.query<{ exists: boolean }>("select app.employee_number_exists($1) as exists", [employee_number]);
      return { exists: res.rows[0]?.exists === true };
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return c.json({ success: true, data: r, request_id: c.get("requestId") }, 200);
  });

  v1.openapi(getRoute, async (c) => {
    const { id } = c.req.valid("param");
    const r = await run(c, deps, (tx) => loadWorker(tx, "w.id = $1", [id]));
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return respondWorker(c, r);
  });

  // --- buat
  v1.openapi(createWorkerRoute, async (c) => {
    const b = c.req.valid("json");
    const orgId = c.get("identity").organizationId;
    if (!orgId) return respondFailure(c, new ApiFailure("FORBIDDEN"));
    const bad = checkContractor(b.employment_status, b.contractor_id);
    if (bad) return respondFailure(c, bad);
    if (b.join_date > addDays(today(), 1))
      return respondFailure(c, new ApiFailure("VALIDATION_ERROR", [{ field: "join_date", issue: "too_far_in_future" }]));
    const nik = sealNik(deps, orgId, b.national_id);
    if (nik instanceof ApiFailure) return respondFailure(c, nik);
    const r = await run(
      c,
      deps,
      async (tx) => {
        await checkPlacement(tx, b);
        const values: Row = {
          organization_id: orgId,
          employee_number: b.employee_number,
          full_name: b.full_name,
          phone: b.phone ?? null,
          email: b.email ?? null,
          employment_status: b.employment_status,
          join_date: b.join_date,
          site_id: b.site_id,
          department_id: b.department_id,
          division_id: b.division_id ?? null,
          job_position_id: b.job_position_id,
          contractor_id: b.contractor_id ?? null,
          ...nik,
        };
        const keys = Object.keys(values);
        const ins = await tx.query<{ id: string }>(
          `insert into worker (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
          keys.map((k) => values[k]),
        );
        return loadWorker(tx, "w.id = $1", [ins.rows[0]?.id]);
      },
      wopts(),
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("Location", `/api/v1/workers/${r.id}`);
    return respondWorker(c, r, 201);
  });

  // --- ubah
  v1.openapi(patchRoute, async (c) => {
    const { id } = c.req.valid("param");
    const expected = parseIfMatch(c.req.valid("header")["if-match"]);
    const b = c.req.valid("json");
    const orgId = c.get("identity").organizationId as string;
    const nik = sealNik(deps, orgId, b.national_id);
    if (nik instanceof ApiFailure) return respondFailure(c, nik);
    const r = await run(
      c,
      deps,
      async (tx) => {
        const cur = await tx.query<{ employment_status: string; contractor_id: string | null; worker_status: string }>(
          "select employment_status, contractor_id, worker_status from worker where id = $1 and deleted_at is null",
          [id],
        );
        const row = cur.rows[0];
        if (!row) throw new ApiFailure("NOT_FOUND");
        if (row.worker_status === "RESIGNED")
          throw new ApiFailure("INVALID_STATE_TRANSITION", [{ field: "worker_status", issue: "resigned_is_final" }]);
        const set: Row = {};
        for (const k of ["full_name", "phone", "email", "employment_status", "contractor_id"] as const) {
          if (b[k] !== undefined) set[k] = b[k];
        }
        const status = (set.employment_status as string | undefined) ?? row.employment_status;
        // status kerja berubah ke selain CONTRACTOR tanpa contractor_id eksplisit: kontraktor dilepas
        if (status !== "CONTRACTOR" && b.contractor_id === undefined && row.contractor_id) set.contractor_id = null;
        const contractor = set.contractor_id !== undefined ? (set.contractor_id as string | null) : row.contractor_id;
        const bad = checkContractor(status, contractor);
        if (bad) throw bad;
        Object.assign(set, nik);
        await updateRow(tx, "worker", "id, version", id, set, expected);
        return loadWorker(tx, "w.id = $1", [id]);
      },
      wopts(),
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return respondWorker(c, r);
  });

  // --- aksi status
  for (const action of Object.keys(TRANSITIONS) as (keyof typeof TRANSITIONS)[]) {
    v1.openapi(statusRoute(action), async (c) => {
      const { id } = c.req.valid("param");
      const expected = parseIfMatch(c.req.valid("header")["if-match"]);
      const b = c.req.valid("json");
      const reason = (b.reason ?? "").trim();
      if (reason.length < 3)
        return respondFailure(c, new ApiFailure("REASON_REQUIRED", [{ field: "reason", issue: "required" }]));
      const t = TRANSITIONS[action];
      if (action === "resign" && !b.exit_date)
        return respondFailure(c, new ApiFailure("VALIDATION_ERROR", [{ field: "exit_date", issue: "required" }]));
      const r = await run(
        c,
        deps,
        async (tx) => {
          const cur = await tx.query<{ worker_status: string }>(
            "select worker_status from worker where id = $1 and deleted_at is null",
            [id],
          );
          const status = cur.rows[0]?.worker_status;
          if (!status) throw new ApiFailure("NOT_FOUND");
          if (!(t.from as readonly string[]).includes(status)) {
            throw new ApiFailure("INVALID_STATE_TRANSITION", [{ field: "worker_status", issue: `from_${status}` }]);
          }
          const set: Row = { worker_status: t.to };
          if (action === "resign") set.exit_date = b.exit_date;
          if (action === "reactivate" || action === "reinstate") set.exit_date = null;
          await updateRow(tx, "worker", "id, version", id, set, expected);
          return loadWorker(tx, "w.id = $1", [id]);
        },
        wopts({ settings: { change_reason: reason } }),
      );
      if (r instanceof ApiFailure) return respondFailure(c, r);
      return respondWorker(c, r);
    });
  }

  // --- penempatan
  v1.openapi(assignmentsRoute, async (c) => {
    const { id } = c.req.valid("param");
    const r = await run(c, deps, async (tx) => {
      const w = await tx.query("select 1 from worker where id = $1 and deleted_at is null", [id]);
      if (!w.rows[0]) throw new ApiFailure("NOT_FOUND");
      const res = await tx.query(
        `select a.id, a.site_id, s.name as site_name, a.department_id, d.name as department_name, a.division_id, dv.name as division_name,
                a.job_position_id, jp.name as job_position_name, a.effective_from::text as effective_from,
                a.effective_until::text as effective_until, (a.effective_until is null) as current, a.reason, a.created_at
         from worker_assignment a
         left join site s on s.id = a.site_id
         left join department d on d.id = a.department_id
         left join division dv on dv.id = a.division_id
         left join job_position jp on jp.id = a.job_position_id
         where a.worker_id = $1 order by a.effective_from desc, a.created_at desc limit ${LIST_LIMIT}`,
        [id],
      );
      return (res.rows as Row[]).map((a) =>
        serialize({
          id: a.id,
          site: ref(a.site_id, a.site_name),
          department: ref(a.department_id, a.department_name),
          division: ref(a.division_id, a.division_name),
          job_position: ref(a.job_position_id, a.job_position_name),
          effective_from: a.effective_from,
          effective_until: a.effective_until,
          current: a.current,
          reason: a.reason,
          created_at: a.created_at,
        }),
      );
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return c.json(
      {
        success: true,
        data: r,
        pagination: { limit: LIST_LIMIT, next_cursor: null, has_more: false },
        request_id: c.get("requestId"),
      },
      200,
    );
  });

  v1.openapi(assignRoute, async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const reason = (b.reason ?? "").trim();
    if (reason.length < 3) return respondFailure(c, new ApiFailure("REASON_REQUIRED", [{ field: "reason", issue: "required" }]));
    // Penempatan bertanggal mendatang butuh penerapan terjadwal (API-003 §4); belum tersedia di M2.4.
    if (b.effective_from > today())
      return respondFailure(
        c,
        new ApiFailure("VALIDATION_ERROR", [{ field: "effective_from", issue: "future_not_supported_yet" }]),
      );
    const r = await run(
      c,
      deps,
      async (tx) => {
        const cur = await tx.query<{ organization_id: string; site_id: string; worker_status: string; can_origin: boolean }>(
          `select organization_id, site_id, worker_status,
                  ((select app.has_org_wide('worker.update')) or site_id = any ((select app.permitted_sites('worker.update'))::uuid[])) as can_origin
           from worker where id = $1 and deleted_at is null`,
          [id],
        );
        const w = cur.rows[0];
        if (!w) throw new ApiFailure("NOT_FOUND");
        // scope Site asal dan tujuan (API-003 §4); tujuan ditegakkan kebijakan insert
        if (!w.can_origin) throw new ApiFailure("SCOPE_DENIED");
        if (w.worker_status === "RESIGNED" || w.worker_status === "INACTIVE") {
          throw new ApiFailure("INVALID_STATE_TRANSITION", [{ field: "worker_status", issue: `from_${w.worker_status}` }]);
        }
        await checkPlacement(tx, b);
        await tx.query(
          `insert into worker_assignment (organization_id, worker_id, site_id, department_id, division_id, job_position_id, effective_from, reason)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [w.organization_id, id, b.site_id, b.department_id, b.division_id ?? null, b.job_position_id, b.effective_from, reason],
        );
        return loadWorker(tx, "w.id = $1", [id]);
      },
      wopts(),
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return respondWorker(c, r, 201);
  });

  // --- kontraktor (pemilih)
  v1.openapi(contractorsRoute, async (c) => {
    const { status } = c.req.valid("query");
    const r = await run(c, deps, async (tx) => {
      const res = await tx.query(
        `select c.id, c.code, c.name, c.status,
                coalesce((select array_agg(cs.site_id order by cs.site_id) from contractor_site cs
                          where cs.contractor_id = c.id and cs.valid_until is null), '{}') as site_ids
         from contractor c ${status ? "where c.status = $1" : ""} order by c.name, c.id limit ${LIST_LIMIT}`,
        status ? [status] : [],
      );
      return res.rows as Row[];
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return c.json(
      {
        success: true,
        data: r,
        pagination: { limit: LIST_LIMIT, next_cursor: null, has_more: false },
        request_id: c.get("requestId"),
      },
      200,
    );
  });
}

import { createRoute, z } from "@hono/zod-openapi";
import type { Tx } from "@soh/db";
import {
  ApiFailure,
  baseErrors,
  type Deps,
  ErrorResponse,
  guard,
  guardAny,
  guardScoped,
  IfMatch,
  json,
  LIST_LIMIT,
  list,
  ok,
  parseIfMatch,
  type Row,
  respondFailure,
  run,
  security,
  serialize,
  type V1,
} from "./route-kit.js";

/**
 * Readiness (API-014 bagian 2, 3, 5, 6; SRS-RE v1.2.1; B-02, B-30). M4.2.
 * - Status dan alasan dihitung engine di database (`app.readiness_evaluate`), klien tidak pernah mengirim status.
 * - Item hanya lewat `app.readiness_items` yang menyamarkan item medis tidak terpenuhi bagi selain Medical Officer, Dokter,
 *   dan pekerja sendiri (`NOT_MET` / `MEDICAL_REQUIREMENT_NOT_MET`, nama "Syarat Medical", tanpa tanggal dan sumber).
 * - Requirement Profile berversi: DRAFT -> ACTIVE -> ARCHIVED. Aktivasi sinkron di database; evaluasi ulang pekerja posisi
 *   itu berjalan lewat antrean (worker/pg_cron, sekitar satu menit). Pratinjau dampak aktivasi menyusul.
 */

const STATUS = z.enum(["READY", "CONDITIONAL", "NOT_READY"]);
const ITEM_TYPES = ["COMPETENCY", "MEDICAL", "AUTHORIZATION", "SIMPER"] as const;
const MASKED_NAME = "Syarat Medical";

const ReadinessItem = z
  .object({
    profile_item_id: z.uuid(),
    item_type: z.enum(ITEM_TYPES),
    requirement_name: z.string(),
    requirement_status: z.enum([
      "VALID",
      "EXPIRING_SOON",
      "EXPIRED",
      "MISSING",
      "PENDING_VERIFICATION",
      "REJECTED",
      "SUSPENDED",
      "RESTRICTED",
      "NOT_MET",
    ]),
    is_mandatory: z.boolean(),
    expiry_date: z.string().nullable(),
    reason_code: z.string(),
    masked: z.boolean().openapi({ description: "Item medis disamarkan untuk peran Anda (SRS-RE 10)" }),
  })
  .openapi("ReadinessItem");

const Readiness = z
  .object({
    worker_id: z.uuid(),
    snapshot_id: z.uuid(),
    status: STATUS,
    score: z.number().openapi({ description: "Informatif saja; status ditentukan syarat (B-02)" }),
    reason_code: z.enum(["WORKER_INACTIVE", "PROFILE_NOT_SET"]).nullable(),
    evaluated_at: z.string(),
    next_evaluation_at: z.string().nullable(),
    trigger_type: z.string(),
    rule_version: z.string(),
    profile: z.object({ id: z.uuid(), version: z.number() }).nullable(),
    items: z.array(ReadinessItem),
  })
  .openapi("WorkerReadiness");

const Snapshot = z
  .object({
    id: z.uuid(),
    status: STATUS,
    previous_status: STATUS.nullable(),
    score: z.number(),
    reason_code: z.string().nullable(),
    profile_version: z.number().nullable(),
    trigger_type: z.string(),
    evaluated_at: z.string(),
  })
  .openapi("ReadinessSnapshot");

const WorkerParam = z.object({ worker_id: z.uuid() });
const IdParam = z.object({ id: z.uuid() });

async function snapshotItems(tx: Tx, snapshotId: string): Promise<Row[]> {
  const r = await tx.query(
    `select profile_item_id, item_type, item_name, requirement_status, is_mandatory, expiry_date::text as expiry_date,
            reason_code, masked
       from app.readiness_items($1)`,
    [snapshotId],
  );
  return r.rows.map((i) => ({
    profile_item_id: i.profile_item_id,
    item_type: i.item_type,
    requirement_name: i.masked ? MASKED_NAME : (i.item_name ?? "-"),
    requirement_status: i.requirement_status,
    is_mandatory: i.is_mandatory,
    expiry_date: i.expiry_date ?? null,
    reason_code: i.reason_code,
    masked: i.masked,
  }));
}

async function loadReadiness(tx: Tx, workerId: string): Promise<Row> {
  const r = await tx.query(
    `select rc.worker_id, rc.snapshot_id, rc.status, rc.score, rc.evaluated_at, rc.next_evaluation_at,
            rs.reason_code, rs.trigger_type, rs.rule_version, rs.profile_id, rs.profile_version
       from readiness_current rc join readiness_snapshot rs on rs.id = rc.snapshot_id
      where rc.worker_id = $1`,
    [workerId],
  );
  const row = r.rows[0];
  if (!row) throw new ApiFailure("NOT_FOUND");
  const items = await snapshotItems(tx, row.snapshot_id as string);
  const { profile_id, profile_version, ...rest } = serialize(row);
  return {
    ...rest,
    profile: profile_id ? { id: profile_id, version: profile_version } : null,
    items,
  };
}

// ---------------------------------------------------------------- Requirement Profile

const ProfileItemInput = z
  .object({
    item_type: z.string().openapi({ description: "COMPETENCY, MEDICAL, AUTHORIZATION, SIMPER (TRAINING menyusul P3)" }),
    competency_id: z.uuid().optional(),
    medical_exam_type_id: z.uuid().optional(),
    authorization_type_id: z.uuid().optional(),
    simper_type_id: z.uuid().optional(),
    equipment_class_id: z.uuid().optional().openapi({ description: "Hanya untuk SIMPER: kelas alat yang disyaratkan" }),
    is_mandatory: z.boolean().default(true),
    warning_days: z.number().int().min(0).max(365).default(30),
  })
  .strict()
  .openapi("RequirementProfileItemInput");

const ProfileItem = z
  .object({
    id: z.uuid(),
    item_type: z.enum(ITEM_TYPES),
    requirement_name: z.string(),
    competency_id: z.uuid().nullable(),
    medical_exam_type_id: z.uuid().nullable(),
    authorization_type_id: z.uuid().nullable(),
    simper_type_id: z.uuid().nullable(),
    equipment_class_id: z.uuid().nullable(),
    is_mandatory: z.boolean(),
    warning_days: z.number(),
    display_order: z.number(),
  })
  .openapi("RequirementProfileItem");

const Profile = z
  .object({
    id: z.uuid(),
    job_position: z.object({ id: z.uuid(), name: z.string(), code: z.string() }),
    profile_version: z.number(),
    status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]),
    effective_from: z.string().nullable(),
    notes: z.string().nullable(),
    activated_at: z.string().nullable(),
    item_count: z.number(),
    version: z.number().openapi({ description: "Versi baris untuk If-Match (bukan nomor versi profile)" }),
    created_at: z.string(),
    items: z.array(ProfileItem).optional(),
  })
  .openapi("RequirementProfile");

const ProfileWrite = z
  .object({
    notes: z.string().trim().max(1000).optional(),
    effective_from: z.iso.date().optional(),
    items: z.array(ProfileItemInput).max(50),
  })
  .strict();
const ProfileCreate = ProfileWrite.extend({ job_position_id: z.uuid() }).strict().openapi("RequirementProfileCreate");

const PROFILE_SELECT = `select p.id, json_build_object('id', jp.id, 'name', jp.name, 'code', jp.code) as job_position,
    p.profile_version, p.status, p.effective_from::text as effective_from, p.notes, p.activated_at,
    (select count(*)::int from requirement_profile_item i where i.profile_id = p.id) as item_count, p.version, p.created_at
  from requirement_profile p join job_position jp on jp.id = p.job_position_id`;

const ITEMS_SELECT = `select i.id, i.item_type,
    coalesce(case i.item_type
      when 'COMPETENCY' then (select name from competency where id = i.competency_id)
      when 'MEDICAL' then (select name from medical_exam_type where id = i.medical_exam_type_id)
      when 'AUTHORIZATION' then (select name from authorization_type where id = i.authorization_type_id)
      else (select name from simper_type where id = i.simper_type_id)
           || coalesce(' / ' || (select name from equipment_class where id = i.equipment_class_id), '') end, '-') as requirement_name,
    i.competency_id, i.medical_exam_type_id, i.authorization_type_id, i.simper_type_id, i.equipment_class_id,
    i.is_mandatory, i.warning_days, i.display_order
  from requirement_profile_item i where i.profile_id = $1 order by i.display_order, i.id`;

const REF_FIELD = {
  COMPETENCY: "competency_id",
  MEDICAL: "medical_exam_type_id",
  AUTHORIZATION: "authorization_type_id",
  SIMPER: "simper_type_id",
} as const;

type ItemInput = z.infer<typeof ProfileItemInput>;

/** Tepat satu rujukan master sesuai jenis; kelas alat hanya SIMPER; TRAINING belum tersedia (B-30). */
export function validateProfileItems(items: ItemInput[]): ApiFailure | null {
  const seen = new Set<string>();
  for (const [idx, it] of items.entries()) {
    if (it.item_type === "TRAINING")
      return new ApiFailure("ITEM_TYPE_NOT_AVAILABLE", [{ field: `items[${idx}].item_type`, issue: "TRAINING_P3" }]);
    if (!(ITEM_TYPES as readonly string[]).includes(it.item_type))
      return new ApiFailure("VALIDATION_ERROR", [{ field: `items[${idx}].item_type`, issue: "invalid_enum" }]);
    const field = REF_FIELD[it.item_type as keyof typeof REF_FIELD];
    const refs = Object.values(REF_FIELD).filter((f) => it[f]);
    if (refs.length !== 1 || refs[0] !== field)
      return new ApiFailure("INVALID_REQUIREMENT_REFERENCE", [
        { field: `items[${idx}].${field}`, issue: "exactly_one_reference" },
      ]);
    if (it.equipment_class_id && it.item_type !== "SIMPER")
      return new ApiFailure("INVALID_REQUIREMENT_REFERENCE", [
        { field: `items[${idx}].equipment_class_id`, issue: "simper_only" },
      ]);
    const key = `${it.item_type}:${it[field]}:${it.equipment_class_id ?? ""}`;
    if (seen.has(key)) return new ApiFailure("DUPLICATE", [{ field: `items[${idx}]`, issue: "duplicate_requirement" }]);
    seen.add(key);
  }
  return null;
}

function mapProfileError(e: { code?: string; message?: string; constraint?: string }): ApiFailure | undefined {
  const msg = e.message ?? "";
  if (e.code === "23514") {
    if (msg.startsWith("PROFILE_EMPTY")) return new ApiFailure("PROFILE_EMPTY");
    if (msg.startsWith("PROFILE_LOCKED")) return new ApiFailure("PROFILE_NOT_DRAFT");
    if (msg.startsWith("INVALID_STATE_TRANSITION")) return new ApiFailure("INVALID_STATE_TRANSITION");
    if (e.constraint?.startsWith("requirement_profile_item_")) return new ApiFailure("INVALID_REQUIREMENT_REFERENCE");
  }
  if (e.code === "23503") return new ApiFailure("INVALID_REQUIREMENT_REFERENCE", [{ issue: "reference_not_found" }]);
  if (e.code === "23505") {
    if (e.constraint === "requirement_profile_item_requirement_uq")
      return new ApiFailure("DUPLICATE", [{ field: "items", issue: "duplicate_requirement" }]);
    return new ApiFailure("CONFLICT", [{ field: "job_position_id", issue: "DRAFT_EXISTS" }]);
  }
  if (e.code === "42501") return new ApiFailure("SCOPE_DENIED");
  return undefined;
}

async function insertItems(tx: Tx, org: string, profileId: string, items: ItemInput[]) {
  for (const [idx, it] of items.entries()) {
    await tx.query(
      `insert into requirement_profile_item (organization_id, profile_id, item_type, competency_id, medical_exam_type_id,
         authorization_type_id, simper_type_id, equipment_class_id, is_mandatory, warning_days, display_order)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        org,
        profileId,
        it.item_type,
        it.competency_id ?? null,
        it.medical_exam_type_id ?? null,
        it.authorization_type_id ?? null,
        it.simper_type_id ?? null,
        it.equipment_class_id ?? null,
        it.is_mandatory,
        it.warning_days,
        idx + 1,
      ],
    );
  }
}

async function loadProfile(tx: Tx, id: string, withItems = true): Promise<Row> {
  const r = await tx.query(`${PROFILE_SELECT} where p.id = $1`, [id]);
  const row = r.rows[0];
  if (!row) throw new ApiFailure("NOT_FOUND");
  const out = serialize(row);
  if (withItems) out.items = (await tx.query(ITEMS_SELECT, [id])).rows;
  return out;
}

/** Hanya satu draf per posisi; posisi dengan profile ACTIVE/ARCHIVED memakai new-version. */
async function assertNoDraft(tx: Tx, jobPositionId: string) {
  const d = await tx.query("select 1 from requirement_profile where job_position_id = $1 and status = 'DRAFT'", [jobPositionId]);
  if (d.rowCount) throw new ApiFailure("CONFLICT", [{ field: "job_position_id", issue: "DRAFT_EXISTS" }]);
}

export function registerReadiness(v1: V1, deps: Deps) {
  const tag = ["Readiness"];
  const notFound = { 404: json(ErrorResponse, "NOT_FOUND (belum dievaluasi, tidak ada, atau di luar scope)") };

  // ------------------------------------------------------------ status pekerja
  const getRoute = createRoute({
    method: "get",
    path: "/workers/{worker_id}/readiness",
    tags: tag,
    summary: "Status kesiapan pekerja dan alasan per syarat (item medis disamarkan sesuai peran)",
    security,
    middleware: guardScoped(deps, "readiness.read"),
    request: { params: WorkerParam },
    responses: { 200: json(ok(Readiness), "Kesiapan"), ...baseErrors, ...notFound },
  });
  v1.openapi(getRoute, async (c) => {
    const { worker_id } = c.req.valid("param");
    const r = await run(c, deps, (tx) => loadReadiness(tx, worker_id));
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, data: r, request_id: c.get("requestId") }, 200);
  });

  const historyRoute = createRoute({
    method: "get",
    path: "/workers/{worker_id}/readiness/history",
    tags: tag,
    summary: "Riwayat perubahan status kesiapan (snapshot terbaru dahulu)",
    security,
    middleware: guardScoped(deps, "readiness.read"),
    request: { params: WorkerParam, query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }) },
    responses: { 200: json(list(Snapshot), "Riwayat"), ...baseErrors },
  });
  v1.openapi(historyRoute, async (c) => {
    const { worker_id } = c.req.valid("param");
    const { limit } = c.req.valid("query");
    const r = await run(
      c,
      deps,
      async (tx) =>
        (
          await tx.query(
            `select id, status, previous_status, score, reason_code, profile_version, trigger_type, evaluated_at
               from readiness_snapshot where worker_id = $1 order by evaluated_at desc, id limit $2`,
            [worker_id, limit],
          )
        ).rows as Row[],
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        success: true,
        data: r.map(serialize),
        pagination: { limit, next_cursor: null, has_more: r.length === limit },
        request_id: c.get("requestId"),
      },
      200,
    );
  });

  const snapshotRoute = createRoute({
    method: "get",
    path: "/readiness/snapshots/{id}",
    tags: tag,
    summary: "Rincian satu snapshot (penyamaran yang sama)",
    security,
    middleware: guardScoped(deps, "readiness.read"),
    request: { params: IdParam },
    responses: {
      200: json(ok(Snapshot.extend({ worker_id: z.uuid(), items: z.array(ReadinessItem) })), "Snapshot"),
      ...baseErrors,
      ...notFound,
    },
  });
  v1.openapi(snapshotRoute, async (c) => {
    const { id } = c.req.valid("param");
    const r = await run(c, deps, async (tx) => {
      const s = await tx.query(
        `select id, worker_id, status, previous_status, score, reason_code, profile_version, trigger_type, evaluated_at
           from readiness_snapshot where id = $1`,
        [id],
      );
      if (!s.rows[0]) throw new ApiFailure("NOT_FOUND");
      return { ...serialize(s.rows[0]), items: await snapshotItems(tx, id) };
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, data: r, request_id: c.get("requestId") }, 200);
  });

  const evaluateRoute = createRoute({
    method: "post",
    path: "/workers/{worker_id}/readiness/evaluate",
    tags: tag,
    summary: "Evaluasi ulang manual satu pekerja (readiness.evaluate pada Site pekerja, teraudit)",
    security,
    middleware: guardScoped(deps, "readiness.evaluate"),
    request: { params: WorkerParam },
    responses: { 200: json(ok(Readiness), "Hasil evaluasi"), ...baseErrors, ...notFound },
  });
  v1.openapi(evaluateRoute, async (c) => {
    const { worker_id } = c.req.valid("param");
    const r = await run(
      c,
      deps,
      async (tx) => {
        await tx.query("select app.readiness_evaluate_manual($1)", [worker_id]);
        return loadReadiness(tx, worker_id);
      },
      { map: (e) => (e.code === "P0002" ? new ApiFailure("NOT_FOUND") : undefined) },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, data: r, request_id: c.get("requestId") }, 200);
  });

  // ------------------------------------------------------------ Requirement Profile
  const readGuard = guardAny(deps, ["readiness.read", "readiness_profile.manage", "organization.read"]);
  const manageGuard = guard(deps, "readiness_profile.manage");
  const writeErrs = {
    ...baseErrors,
    404: json(ErrorResponse, "NOT_FOUND"),
    409: json(ErrorResponse, "PROFILE_NOT_DRAFT, PROFILE_EMPTY, POSITION_HAS_ACTIVE_PROFILE, CONFLICT (DRAFT_EXISTS), DUPLICATE"),
    412: json(ErrorResponse, "VERSION_CONFLICT"),
    422: json(ErrorResponse, "VALIDATION_ERROR, ITEM_TYPE_NOT_AVAILABLE, INVALID_REQUIREMENT_REFERENCE"),
  };

  const listProfiles = createRoute({
    method: "get",
    path: "/requirement-profiles",
    tags: tag,
    summary: "Daftar Requirement Profile",
    security,
    middleware: readGuard,
    request: {
      query: z.object({ job_position_id: z.uuid().optional(), status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).optional() }),
    },
    responses: { 200: json(list(Profile), `Daftar (maksimum ${LIST_LIMIT})`), ...baseErrors },
  });
  v1.openapi(listProfiles, async (c) => {
    const q = c.req.valid("query");
    const r = await run(
      c,
      deps,
      async (tx) =>
        (
          await tx.query(
            `${PROFILE_SELECT} where ($1::uuid is null or p.job_position_id = $1) and ($2::text is null or p.status = $2)
              order by jp.name, p.profile_version desc limit ${LIST_LIMIT}`,
            [q.job_position_id ?? null, q.status ?? null],
          )
        ).rows as Row[],
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return c.json(
      {
        success: true,
        data: r.map(serialize),
        pagination: { limit: LIST_LIMIT, next_cursor: null, has_more: false },
        request_id: c.get("requestId"),
      },
      200,
    );
  });

  const getProfile = createRoute({
    method: "get",
    path: "/requirement-profiles/{id}",
    tags: tag,
    summary: "Detail Requirement Profile beserta syarat",
    security,
    middleware: readGuard,
    request: { params: IdParam },
    responses: { 200: json(ok(Profile), "Profile"), ...baseErrors, 404: json(ErrorResponse, "NOT_FOUND") },
  });
  v1.openapi(getProfile, async (c) => {
    const { id } = c.req.valid("param");
    const r = await run(c, deps, (tx) => loadProfile(tx, id));
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("ETag", `"${r.version}"`);
    return c.json({ success: true, data: r, request_id: c.get("requestId") }, 200);
  });

  const createProfile = createRoute({
    method: "post",
    path: "/requirement-profiles",
    tags: tag,
    summary: "Membuat draf Requirement Profile untuk posisi yang belum memiliki profile",
    security,
    middleware: manageGuard,
    request: { body: { content: { "application/json": { schema: ProfileCreate } }, required: true } },
    responses: { 201: json(ok(Profile), "Draf dibuat"), ...writeErrs },
  });
  v1.openapi(createProfile, async (c) => {
    const b = c.req.valid("json");
    const bad = validateProfileItems(b.items);
    if (bad) return respondFailure(c, bad);
    const identity = c.get("identity");
    if (!identity.organizationId) return respondFailure(c, new ApiFailure("FORBIDDEN"));
    const r = await run(
      c,
      deps,
      async (tx) => {
        const jp = await tx.query("select 1 from job_position where id = $1", [b.job_position_id]);
        if (!jp.rowCount) throw new ApiFailure("VALIDATION_ERROR", [{ field: "job_position_id", issue: "not_found" }]);
        const existing = await tx.query<{ status: string }>("select status from requirement_profile where job_position_id = $1", [
          b.job_position_id,
        ]);
        if (existing.rows.some((x) => x.status === "DRAFT"))
          throw new ApiFailure("CONFLICT", [{ field: "job_position_id", issue: "DRAFT_EXISTS" }]);
        if (existing.rowCount) throw new ApiFailure("POSITION_HAS_ACTIVE_PROFILE");
        const ins = await tx.query<{ id: string }>(
          `insert into requirement_profile (organization_id, job_position_id, profile_version, notes, effective_from, created_by)
           values ($1, $2, 1, $3, $4, $5) returning id`,
          [identity.organizationId, b.job_position_id, b.notes || null, b.effective_from ?? null, identity.userId],
        );
        const id = ins.rows[0]?.id as string;
        await insertItems(tx, identity.organizationId as string, id, b.items);
        return loadProfile(tx, id);
      },
      { map: mapProfileError },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("ETag", `"${r.version}"`);
    return c.json({ success: true, data: r, request_id: c.get("requestId") }, 201);
  });

  const putProfile = createRoute({
    method: "put",
    path: "/requirement-profiles/{id}",
    tags: tag,
    summary: "Mengganti isi draf (catatan, tanggal berlaku, seluruh syarat). Hanya DRAFT",
    security,
    middleware: manageGuard,
    request: {
      params: IdParam,
      headers: IfMatch,
      body: { content: { "application/json": { schema: ProfileWrite.openapi("RequirementProfileUpdate") } }, required: true },
    },
    responses: { 200: json(ok(Profile), "Draf diperbarui"), ...writeErrs },
  });
  v1.openapi(putProfile, async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const expected = parseIfMatch(c.req.header("if-match"));
    const bad = validateProfileItems(b.items);
    if (bad) return respondFailure(c, bad);
    const identity = c.get("identity");
    const r = await run(
      c,
      deps,
      async (tx) => {
        const cur = await tx.query<{ status: string; version: number }>(
          "select status, version from requirement_profile where id = $1 for update",
          [id],
        );
        const row = cur.rows[0];
        if (!row) throw new ApiFailure("NOT_FOUND");
        if (row.status !== "DRAFT") throw new ApiFailure("PROFILE_NOT_DRAFT");
        if (expected !== null && expected !== row.version)
          throw new ApiFailure("VERSION_CONFLICT", undefined, { current_version: row.version });
        const up = await tx.query("update requirement_profile set notes = $2, effective_from = $3 where id = $1", [
          id,
          b.notes || null,
          b.effective_from ?? null,
        ]);
        if (!up.rowCount) throw new ApiFailure("SCOPE_DENIED");
        await tx.query("delete from requirement_profile_item where profile_id = $1", [id]);
        await insertItems(tx, identity.organizationId as string, id, b.items);
        return loadProfile(tx, id);
      },
      { map: mapProfileError },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("ETag", `"${r.version}"`);
    return c.json({ success: true, data: r, request_id: c.get("requestId") }, 200);
  });

  const deleteProfile = createRoute({
    method: "delete",
    path: "/requirement-profiles/{id}",
    tags: tag,
    summary: "Menghapus draf (profile ACTIVE/ARCHIVED tidak dapat dihapus)",
    security,
    middleware: manageGuard,
    request: { params: IdParam },
    responses: { 200: json(ok(z.object({ id: z.uuid(), deleted: z.literal(true) })), "Dihapus"), ...writeErrs },
  });
  v1.openapi(deleteProfile, async (c) => {
    const { id } = c.req.valid("param");
    const r = await run(
      c,
      deps,
      async (tx) => {
        const cur = await tx.query<{ status: string }>("select status from requirement_profile where id = $1", [id]);
        if (!cur.rows[0]) throw new ApiFailure("NOT_FOUND");
        if (cur.rows[0].status !== "DRAFT") throw new ApiFailure("PROFILE_NOT_DRAFT");
        const del = await tx.query("delete from requirement_profile where id = $1", [id]);
        if (!del.rowCount) throw new ApiFailure("SCOPE_DENIED");
        return { id, deleted: true as const };
      },
      { map: mapProfileError },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return c.json({ success: true, data: r, request_id: c.get("requestId") }, 200);
  });

  const newVersion = createRoute({
    method: "post",
    path: "/requirement-profiles/{id}/new-version",
    tags: tag,
    summary: "Menyalin profile ACTIVE/ARCHIVED menjadi draf versi berikutnya",
    security,
    middleware: manageGuard,
    request: { params: IdParam },
    responses: { 201: json(ok(Profile), "Draf versi baru"), ...writeErrs },
  });
  v1.openapi(newVersion, async (c) => {
    const { id } = c.req.valid("param");
    const identity = c.get("identity");
    const r = await run(
      c,
      deps,
      async (tx) => {
        const src = await tx.query<{ status: string; job_position_id: string; notes: string | null }>(
          "select status, job_position_id, notes from requirement_profile where id = $1",
          [id],
        );
        const s = src.rows[0];
        if (!s) throw new ApiFailure("NOT_FOUND");
        if (s.status === "DRAFT") throw new ApiFailure("INVALID_STATE_TRANSITION");
        await assertNoDraft(tx, s.job_position_id);
        const ins = await tx.query<{ id: string }>(
          `insert into requirement_profile (organization_id, job_position_id, profile_version, notes, created_by)
           select organization_id, job_position_id,
                  (select max(profile_version) + 1 from requirement_profile where job_position_id = $2), notes, $3
             from requirement_profile where id = $1 returning id`,
          [id, s.job_position_id, identity.userId],
        );
        const nid = ins.rows[0]?.id as string;
        await tx.query(
          `insert into requirement_profile_item (organization_id, profile_id, item_type, competency_id, medical_exam_type_id,
             authorization_type_id, simper_type_id, equipment_class_id, is_mandatory, warning_days, weight_override, display_order)
           select organization_id, $2, item_type, competency_id, medical_exam_type_id, authorization_type_id, simper_type_id,
                  equipment_class_id, is_mandatory, warning_days, weight_override, display_order
             from requirement_profile_item where profile_id = $1`,
          [id, nid],
        );
        return loadProfile(tx, nid);
      },
      { map: mapProfileError },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("ETag", `"${r.version}"`);
    return c.json({ success: true, data: r, request_id: c.get("requestId") }, 201);
  });

  const activate = createRoute({
    method: "post",
    path: "/requirement-profiles/{id}/activate",
    tags: tag,
    summary: "Mengaktifkan draf; versi aktif sebelumnya diarsipkan; pekerja posisi itu dievaluasi ulang lewat antrean",
    security,
    middleware: manageGuard,
    request: { params: IdParam, headers: IfMatch },
    responses: { 200: json(ok(Profile), "Aktif"), ...writeErrs },
  });
  v1.openapi(activate, async (c) => {
    const { id } = c.req.valid("param");
    const expected = parseIfMatch(c.req.header("if-match"));
    const r = await run(
      c,
      deps,
      async (tx) => {
        const cur = await tx.query<{ status: string; version: number }>(
          "select status, version from requirement_profile where id = $1 for update",
          [id],
        );
        const row = cur.rows[0];
        if (!row) throw new ApiFailure("NOT_FOUND");
        if (row.status !== "DRAFT") throw new ApiFailure("PROFILE_NOT_DRAFT");
        if (expected !== null && expected !== row.version)
          throw new ApiFailure("VERSION_CONFLICT", undefined, { current_version: row.version });
        const up = await tx.query("update requirement_profile set status = 'ACTIVE' where id = $1", [id]);
        if (!up.rowCount) throw new ApiFailure("SCOPE_DENIED");
        return loadProfile(tx, id);
      },
      { map: mapProfileError },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("ETag", `"${r.version}"`);
    return c.json({ success: true, data: r, request_id: c.get("requestId") }, 200);
  });
}

import { createRoute, z } from "@hono/zod-openapi";
import type { Tx } from "@soh/db";
import { safeFileName } from "./files.js";
import {
  ApiFailure,
  baseErrors,
  type Ctx,
  type Deps,
  ErrorResponse,
  guard,
  guardScoped,
  IfMatch,
  json,
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
import { type FileStorage, StorageError } from "./storage.js";

/**
 * Medical (API-005, SRS-WF004, DB-003 §4, DB-008). Data Sensitif, sintetis saja (B-24).
 * - Tingkat status (`medical.read_status`): /workers/{id}/medical-status dan /medical-restrictions, lewat app.medical_status.
 *   Tanpa dokumen, penyedia, jenis pemeriksaan, komentar.
 * - Tingkat detail (`medical.read_detail`): Dokter, Medical Officer, pekerja sendiri, HSE Manager dengan otorisasi tercatat.
 *   `X-Access-Reason` wajib (>= 10 karakter) kecuali pekerja membaca miliknya; setiap baca dicatat audit sensitif.
 * - Pencatatan administratif: medical.update penuh atau LIMITED (Medical Officer/petugas medis, HSE Officer, Site Admin).
 *   Penetapan Fit to Work hanya Dokter (`medical.verify`, B-27), bukan pembuat record (403 SEPARATION_OF_DUTIES).
 *   Hasil: FIT, FIT_WITH_CONDITION (tindak lanjut ringan, catatan non-diagnostik + tanggal), FIT_WITH_RESTRICTION
 *   (pembatasan operasional), UNFIT (tanggal tinjau ulang opsional).
 * - Pemeriksaan kesiapan kerja khusus (pra-tugas) ada di medical-clearance.ts.
 * - Dokumen MCU: bucket soh-medical, signed URL 60 detik, teraudit sensitif.
 * - Respons detail tidak ditulis ke log aplikasi (logger hanya mencatat metode, jalur, status).
 * Belum di M3.5: evaluasi readiness (M4), notifikasi (M3.6), Idempotency-Key.
 */

export type MedicalDeps = Deps & { storage?: FileStorage | undefined };

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const Fitness = z.enum(["FIT", "FIT_WITH_CONDITION", "FIT_WITH_RESTRICTION", "UNFIT"]);
const DOC_TTL = 60;
const MIN_REASON = 10;

const AccessReason = z.object({
  "x-access-reason": z
    .string()
    .max(500)
    .optional()
    .openapi({ description: "Alasan akses detail medis (wajib, minimal 10 karakter), kecuali pekerja membaca miliknya" }),
});

const Restriction = z
  .object({
    id: z.uuid(),
    restriction_code: z.string(),
    operational_description: z.string(),
    valid_from: z.string(),
    valid_until: z.string().nullable(),
  })
  .openapi("MedicalRestriction");

const MedicalStatus = z
  .object({
    worker_id: z.uuid(),
    fitness_status: Fitness.nullable(),
    validity_status: z.enum(["VALID", "EXPIRING_SOON", "EXPIRED", "MISSING", "PENDING_VERIFICATION", "SUSPENDED"]),
    expiry_date: z.string().nullable(),
    unfit_until: z.string().nullable().openapi({ description: "Tanggal tinjau ulang (hanya UNFIT)" }),
    follow_up_due: z.string().nullable().openapi({ description: "Tanggal tindak lanjut (FIT_WITH_CONDITION), tanpa catatan" }),
    restrictions: z.array(Restriction),
    has_pending: z.boolean(),
  })
  .openapi("MedicalStatus");

const MedicalRecord = z
  .object({
    id: z.uuid(),
    worker_id: z.uuid(),
    site_id: z.uuid(),
    worker_name: z.string().nullable(),
    sho_id: z.string().nullable(),
    exam_type: z.object({ id: z.uuid(), name: z.string().nullable(), code: z.string().nullable() }),
    examination_date: z.string(),
    expiry_date: z.string(),
    provider: z.string().nullable(),
    has_document: z.boolean(),
    fitness_status: Fitness.nullable(),
    unfit_until: z.string().nullable(),
    follow_up_note: z.string().nullable(),
    follow_up_due: z.string().nullable(),
    verification_status: z.enum(["PENDING", "VERIFIED", "REJECTED"]),
    verified_by_name: z.string().nullable(),
    verified_at: z.string().nullable(),
    determination_comment: z.string().nullable(),
    rejection_reason: z.string().nullable(),
    created_by: z.uuid(),
    created_by_name: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    version: z.number().int(),
    restrictions: z.array(Restriction.extend({ status: z.enum(["ACTIVE", "LIFTED"]), lift_reason: z.string().nullable() })),
    can_determine: z.boolean(),
  })
  .openapi("MedicalRecord");

/** $1 = pemanggil, $2 = punya medical.verify. */
const SELECT = `select m.id, m.worker_id, m.site_id, w.full_name as worker_name, w.sho_id,
    json_build_object('id', m.exam_type_id, 'name', t.name, 'code', t.code) as exam_type,
    m.examination_date::text as examination_date, m.expiry_date::text as expiry_date, m.provider,
    (m.file_id is not null) as has_document, m.fitness_status, m.unfit_until::text as unfit_until,
    m.follow_up_note, m.follow_up_due::text as follow_up_due, m.verification_status,
    vb.full_name as verified_by_name, m.verified_at, m.determination_comment, m.rejection_reason,
    m.created_by, cb.full_name as created_by_name, m.created_at, m.updated_at, m.version,
    coalesce((select json_agg(json_build_object('id', r.id, 'restriction_code', r.restriction_code,
                'operational_description', r.operational_description, 'valid_from', r.valid_from::text,
                'valid_until', r.valid_until::text, 'status', r.status, 'lift_reason', r.lift_reason) order by r.valid_from)
              from medical_restriction r where r.medical_record_id = m.id), '[]'::json) as restrictions,
    (m.verification_status = 'PENDING' and m.created_by <> $1::uuid and $2::boolean) as can_determine
  from medical_record m
  left join medical_exam_type t on t.id = m.exam_type_id
  left join worker w on w.id = m.worker_id
  left join user_profile vb on vb.id = m.verified_by
  left join user_profile cb on cb.id = m.created_by`;

const IdParam = z.object({ id: z.uuid() });
const WorkerParam = z.object({ worker_id: z.uuid() });

function mapMedicalError(e: { code?: string; message?: string; constraint?: string }): ApiFailure | undefined {
  const msg = e.message ?? "";
  if (e.code === "23514") {
    if (msg.startsWith("INVALID_STATE_TRANSITION")) return new ApiFailure("INVALID_STATE_TRANSITION");
    if (msg.startsWith("FILE_NOT_CLEAN")) return new ApiFailure("FILE_NOT_CLEAN", [{ field: "file_id", issue: "not_clean" }]);
    if (msg.startsWith("RESTRICTION_NOT_ALLOWED")) return new ApiFailure("RESTRICTION_NOT_ALLOWED");
    if (msg.startsWith("GRANTEE_NOT_ELIGIBLE"))
      return new ApiFailure("GRANTEE_NOT_ELIGIBLE", [{ field: "grantee_user_id", issue: "not_eligible" }]);
    if (e.constraint === "medical_record_range_chk")
      return new ApiFailure("INVALID_DATE_RANGE", [{ field: "expiry_date", issue: "before_examination_date" }]);
    if (e.constraint === "medical_record_sod_chk" || e.constraint === "medical_access_grant_self_chk")
      return new ApiFailure("SEPARATION_OF_DUTIES");
    if (e.constraint === "medical_record_rejected_chk" || e.constraint === "medical_restriction_lift_chk")
      return new ApiFailure("REASON_REQUIRED", [{ field: "reason", issue: "required" }]);
    if (e.constraint === "medical_record_unfit_until_chk")
      return new ApiFailure("VALIDATION_ERROR", [{ field: "unfit_until", issue: "only_for_unfit" }]);
    if (e.constraint === "medical_record_follow_up_chk") return new ApiFailure("FOLLOW_UP_REQUIRED");
    if (e.constraint === "medical_access_grant_window_chk")
      return new ApiFailure("VALIDATION_ERROR", [{ field: "hours", issue: "max_24_hours" }]);
    if (e.constraint === "medical_restriction_range_chk")
      return new ApiFailure("INVALID_DATE_RANGE", [{ field: "restrictions.valid_until", issue: "before_valid_from" }]);
  }
  if (e.code === "42501") return new ApiFailure("SCOPE_DENIED");
  if (e.code === "23505" && e.constraint === "medical_record_file_uq")
    return new ApiFailure("DUPLICATE", [{ field: "file_id", issue: "already_used" }]);
  if (e.code === "23503") return new ApiFailure("VALIDATION_ERROR", [{ issue: "reference_not_found" }]);
  return undefined;
}

const isVerifier = (c: Ctx) => c.get("identity").permissions.has("medical.verify");

async function loadOne(tx: Tx, id: string, me: string, verifier: boolean): Promise<Row> {
  const r = await tx.query(`${SELECT} where m.id = $3`, [me, verifier, id]);
  if (!r.rows[0]) throw new ApiFailure("NOT_FOUND");
  return r.rows[0] as Row;
}

/** Alasan akses detail: wajib kecuali pekerja membaca record miliknya. */
async function accessReason(tx: Tx, c: Ctx, workerId: string): Promise<string> {
  const reason = (c.req.header("x-access-reason") ?? "").trim();
  if (reason.length >= MIN_REASON) return reason;
  const self = await tx.query<{ me: string | null }>("select app.my_worker_id() as me");
  if (self.rows[0]?.me === workerId) return reason || "Pekerja membaca data medis miliknya";
  throw new ApiFailure("ACCESS_REASON_REQUIRED", [{ field: "X-Access-Reason", issue: `min_${MIN_REASON}_chars` }]);
}

async function auditSensitive(tx: Tx, action: string, recordId: string, siteId: string, reason: string) {
  await tx.query(
    "select app.audit_record($1, 'medical_record', $2, null, null, 'medical.read_detail', $3, 'SUCCESS', true, $4)",
    [action, recordId, siteId, reason],
  );
}

function respondOne(c: Ctx, r: Row, status: 200 | 201 = 200): never {
  c.header("ETag", `"${r.version}"`);
  c.header("Cache-Control", "no-store");
  return c.json({ success: true, data: serialize(r), request_id: c.get("requestId") }, status) as never;
}

const listBody = (c: Ctx, rows: Row[]) => {
  c.header("Cache-Control", "no-store");
  return c.json(
    {
      success: true,
      data: rows.map(serialize),
      pagination: { limit: rows.length, next_cursor: null, has_more: false },
      request_id: c.get("requestId"),
    },
    200,
  );
};

export function registerMedical(v1: V1, deps: MedicalDeps) {
  const tag = ["Medical"];
  const errs = {
    ...baseErrors,
    404: json(ErrorResponse, "NOT_FOUND (tidak ada atau di luar scope)"),
    409: json(ErrorResponse, "INVALID_STATE_TRANSITION, DUPLICATE"),
    412: json(ErrorResponse, "VERSION_CONFLICT"),
    422: json(
      ErrorResponse,
      "VALIDATION_ERROR, INVALID_DATE_RANGE, RESTRICTION_REQUIRED, RESTRICTION_NOT_ALLOWED, FOLLOW_UP_REQUIRED, REASON_REQUIRED, FILE_NOT_CLEAN",
    ),
  };

  // ---------------------------------------------------------------- antrean penetapan (sebelum /medical-records/{id})
  const queue = createRoute({
    method: "get",
    path: "/medical-records/pending-determination",
    tags: tag,
    summary: "Antrean penetapan Fit to Work (Dokter)",
    security,
    middleware: guard(deps, "medical.verify"),
    request: { query: z.object({ site_id: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) },
    responses: { 200: json(list(MedicalRecord), "Antrean"), ...baseErrors, 422: json(ErrorResponse, "VALIDATION_ERROR") },
  });
  v1.openapi(queue, async (c) => {
    const q = c.req.valid("query");
    const r = await run(c, deps, async (tx) => {
      const params: unknown[] = [c.get("identity").userId, true];
      let where = "m.verification_status = 'PENDING'";
      if (q.site_id) {
        params.push(q.site_id);
        where += ` and m.site_id = $${params.length}`;
      }
      return (await tx.query(`${SELECT} where ${where} order by m.updated_at, m.id limit ${q.limit}`, params)).rows as Row[];
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return listBody(c, r);
  });

  // ---------------------------------------------------------------- tingkat status
  const statusRoute = createRoute({
    method: "get",
    path: "/workers/{worker_id}/medical-status",
    tags: tag,
    summary: "Status Fit to Work dan pembatasan operasional (tanpa detail medis)",
    security,
    middleware: guardScoped(deps, "medical.read_status"),
    request: { params: WorkerParam },
    responses: { 200: json(ok(MedicalStatus), "Status"), ...baseErrors, 404: json(ErrorResponse, "NOT_FOUND") },
  });
  v1.openapi(statusRoute, async (c) => {
    const { worker_id } = c.req.valid("param");
    const r = await run(c, deps, async (tx) => {
      const res = await tx.query(
        `select worker_id, fitness_status, validity_status, expiry_date::text as expiry_date, unfit_until::text as unfit_until,
                follow_up_due::text as follow_up_due, restrictions, has_pending from app.medical_status($1)`,
        [worker_id],
      );
      if (!res.rows[0]) throw new ApiFailure("NOT_FOUND");
      return res.rows[0] as Row;
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, data: serialize(r), request_id: c.get("requestId") }, 200);
  });

  const restrRoute = createRoute({
    method: "get",
    path: "/workers/{worker_id}/medical-restrictions",
    tags: tag,
    summary: "Pembatasan operasional aktif pekerja",
    security,
    middleware: guardScoped(deps, "medical.read_status"),
    request: { params: WorkerParam },
    responses: { 200: json(list(Restriction), "Pembatasan"), ...baseErrors, 404: json(ErrorResponse, "NOT_FOUND") },
  });
  v1.openapi(restrRoute, async (c) => {
    const { worker_id } = c.req.valid("param");
    const r = await run(c, deps, async (tx) => {
      const res = await tx.query<{ restrictions: Row[] }>("select restrictions from app.medical_status($1)", [worker_id]);
      if (!res.rows[0]) throw new ApiFailure("NOT_FOUND");
      return res.rows[0].restrictions;
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return listBody(c, r);
  });

  // ---------------------------------------------------------------- tingkat detail
  const listRecords = createRoute({
    method: "get",
    path: "/workers/{worker_id}/medical-records",
    tags: tag,
    summary: "Riwayat record medis (detail; X-Access-Reason wajib, teraudit)",
    security,
    middleware: guardScoped(deps, "medical.read_detail"),
    request: { params: WorkerParam, headers: AccessReason },
    responses: {
      200: json(list(MedicalRecord), "Riwayat"),
      ...baseErrors,
      400: json(ErrorResponse, "ACCESS_REASON_REQUIRED"),
      404: json(ErrorResponse, "NOT_FOUND"),
    },
  });
  v1.openapi(listRecords, async (c) => {
    const { worker_id } = c.req.valid("param");
    const r = await run(c, deps, async (tx) => {
      const reason = await accessReason(tx, c, worker_id);
      const res = await tx.query(
        `${SELECT} where m.worker_id = $3 order by m.examination_date desc, m.created_at desc limit 200`,
        [c.get("identity").userId, isVerifier(c), worker_id],
      );
      for (const row of res.rows as Row[])
        await auditSensitive(tx, "medical.read_detail", row.id as string, row.site_id as string, reason);
      return res.rows as Row[];
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return listBody(c, r);
  });

  const getRecord = createRoute({
    method: "get",
    path: "/medical-records/{id}",
    tags: tag,
    summary: "Detail satu record medis (X-Access-Reason wajib, teraudit)",
    security,
    middleware: guardScoped(deps, "medical.read_detail"),
    request: { params: IdParam, headers: AccessReason },
    responses: {
      200: json(ok(MedicalRecord), "Detail"),
      ...baseErrors,
      400: json(ErrorResponse, "ACCESS_REASON_REQUIRED"),
      404: json(ErrorResponse, "NOT_FOUND"),
    },
  });
  v1.openapi(getRecord, async (c) => {
    const { id } = c.req.valid("param");
    const r = await run(c, deps, async (tx) => {
      const row = await loadOne(tx, id, c.get("identity").userId, isVerifier(c));
      const reason = await accessReason(tx, c, row.worker_id as string);
      await auditSensitive(tx, "medical.read_detail", id, row.site_id as string, reason);
      return row;
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return respondOne(c, r);
  });

  const doc = createRoute({
    method: "get",
    path: "/medical-records/{id}/document-url",
    tags: tag,
    summary: "URL dokumen MCU bertanda tangan 60 detik (X-Access-Reason wajib, teraudit)",
    security,
    middleware: guardScoped(deps, "medical.read_detail"),
    request: { params: IdParam, headers: AccessReason },
    responses: {
      200: json(ok(z.object({ url: z.string(), expires_in: z.number().int() })), "URL"),
      ...baseErrors,
      400: json(ErrorResponse, "ACCESS_REASON_REQUIRED"),
      404: json(ErrorResponse, "NOT_FOUND"),
      422: json(ErrorResponse, "FILE_NOT_CLEAN"),
      503: json(ErrorResponse, "SERVICE_UNAVAILABLE"),
    },
  });
  v1.openapi(doc, async (c) => {
    const { id } = c.req.valid("param");
    const storage = deps.storage;
    if (!storage)
      return respondFailure(c, new ApiFailure("SERVICE_UNAVAILABLE", [{ field: "storage", issue: "not_configured" }]));
    const r = await run(c, deps, async (tx) => {
      const res = await tx.query<{
        worker_id: string;
        site_id: string;
        bucket: string | null;
        object_path: string | null;
        original_name: string | null;
        scan_status: string | null;
      }>(
        `select m.worker_id, m.site_id, f.bucket, f.object_path, f.original_name, f.scan_status
           from medical_record m left join file_object f on f.id = m.file_id where m.id = $1`,
        [id],
      );
      const row = res.rows[0];
      if (!row?.bucket || !row.object_path) throw new ApiFailure("NOT_FOUND");
      if (row.scan_status !== "CLEAN") throw new ApiFailure("FILE_NOT_CLEAN");
      const reason = await accessReason(tx, c, row.worker_id);
      await auditSensitive(tx, "medical.document_access", id, row.site_id, reason);
      try {
        return {
          url: await storage.createDownloadUrl(row.bucket, row.object_path, DOC_TTL, safeFileName(row.original_name ?? "mcu")),
          expires_in: DOC_TTL,
        };
      } catch (err) {
        if (err instanceof StorageError) throw new ApiFailure("SERVICE_UNAVAILABLE", [{ field: "storage", issue: "upstream" }]);
        throw err;
      }
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, data: r, request_id: c.get("requestId") }, 200);
  });

  // ---------------------------------------------------------------- pencatatan administratif
  const RecordFields = {
    exam_type_id: z.uuid(),
    examination_date: IsoDate,
    expiry_date: IsoDate,
    provider: z.string().trim().max(150).nullable().optional(),
    file_id: z.uuid().nullable().optional(),
  };
  const createRec = createRoute({
    method: "post",
    path: "/workers/{worker_id}/medical-records",
    tags: tag,
    summary: "Mencatat MCU (administratif; Fit to Work kosong sampai ditetapkan Dokter)",
    security,
    middleware: guardScoped(deps, "medical.update"),
    request: {
      params: WorkerParam,
      body: {
        content: { "application/json": { schema: z.object(RecordFields).openapi("MedicalRecordCreate") } },
        required: true,
      },
    },
    responses: { 201: json(ok(MedicalRecord), "Dicatat"), ...errs },
  });
  v1.openapi(createRec, async (c) => {
    const { worker_id } = c.req.valid("param");
    const b = c.req.valid("json");
    const identity = c.get("identity");
    if (!identity.organizationId) return respondFailure(c, new ApiFailure("FORBIDDEN"));
    if (b.expiry_date < b.examination_date)
      return respondFailure(
        c,
        new ApiFailure("INVALID_DATE_RANGE", [{ field: "expiry_date", issue: "before_examination_date" }]),
      );
    const r = await run(
      c,
      deps,
      async (tx) => {
        const w = await tx.query<{ site_id: string; today: string }>(
          "select site_id, app.site_today(site_id)::text as today from worker where id = $1",
          [worker_id],
        );
        const wr = w.rows[0];
        if (!wr) throw new ApiFailure("NOT_FOUND");
        if (b.examination_date > wr.today)
          throw new ApiFailure("VALIDATION_ERROR", [{ field: "examination_date", issue: "in_future" }]);
        const t = await tx.query<{ status: string }>("select status from medical_exam_type where id = $1", [b.exam_type_id]);
        if (t.rows[0]?.status !== "ACTIVE")
          throw new ApiFailure("VALIDATION_ERROR", [{ field: "exam_type_id", issue: t.rows[0] ? "inactive" : "not_found" }]);
        const ins = await tx.query<{ id: string }>(
          `insert into medical_record (organization_id, site_id, worker_id, exam_type_id, examination_date, expiry_date, provider,
             file_id, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
          [
            identity.organizationId,
            wr.site_id,
            worker_id,
            b.exam_type_id,
            b.examination_date,
            b.expiry_date,
            b.provider || null,
            b.file_id ?? null,
            identity.userId,
          ],
        );
        return loadOne(tx, ins.rows[0]?.id as string, identity.userId, isVerifier(c));
      },
      { map: mapMedicalError },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("Location", `/api/v1/medical-records/${r.id}`);
    return respondOne(c, r, 201);
  });

  const patchRec = createRoute({
    method: "patch",
    path: "/medical-records/{id}",
    tags: tag,
    summary: "Mengubah data administratif MCU (record ditetapkan kembali PENDING, penetapan dikosongkan)",
    security,
    middleware: guardScoped(deps, "medical.update"),
    request: {
      params: IdParam,
      headers: IfMatch,
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                exam_type_id: z.uuid().optional(),
                examination_date: IsoDate.optional(),
                expiry_date: IsoDate.optional(),
                provider: z.string().trim().max(150).nullable().optional(),
                file_id: z.uuid().nullable().optional(),
              })
              .openapi("MedicalRecordPatch"),
          },
        },
        required: true,
      },
    },
    responses: { 200: json(ok(MedicalRecord), "Diubah"), ...errs },
  });
  v1.openapi(patchRec, async (c) => {
    const { id } = c.req.valid("param");
    const expected = parseIfMatch(c.req.valid("header")["if-match"]);
    const b = c.req.valid("json") as Row;
    const me = c.get("identity").userId;
    const r = await run(
      c,
      deps,
      async (tx) => {
        const cur = await tx.query<{ version: number; examination_date: string; expiry_date: string }>(
          "select version, examination_date::text as examination_date, expiry_date::text as expiry_date from medical_record where id = $1",
          [id],
        );
        const row = cur.rows[0];
        if (!row) throw new ApiFailure("NOT_FOUND");
        if (expected !== row.version) throw new ApiFailure("VERSION_CONFLICT", undefined, { current_version: row.version });
        const exam = (b.examination_date as string | undefined) ?? row.examination_date;
        const exp = (b.expiry_date as string | undefined) ?? row.expiry_date;
        if (exp < exam) throw new ApiFailure("INVALID_DATE_RANGE", [{ field: "expiry_date", issue: "before_examination_date" }]);
        const keys = ["exam_type_id", "examination_date", "expiry_date", "provider", "file_id"].filter((k) => b[k] !== undefined);
        if (keys.length) {
          const res = await tx.query(
            `update medical_record set ${keys.map((k, i) => `${k} = $${i + 3}`).join(", ")} where id = $1 and version = $2`,
            [id, row.version, ...keys.map((k) => (b[k] === "" ? null : b[k]))],
          );
          if (res.rowCount === 0) throw new ApiFailure("SCOPE_DENIED");
        }
        return loadOne(tx, id, me, isVerifier(c));
      },
      { map: mapMedicalError },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return respondOne(c, r);
  });

  // ---------------------------------------------------------------- penetapan Fit to Work
  const RestrictionInput = z.object({
    restriction_code: z.string().regex(/^[A-Z][A-Z0-9_]{2,49}$/),
    operational_description: z.string().trim().min(5).max(300),
    valid_from: IsoDate,
    valid_until: IsoDate.nullable().optional(),
  });
  const determine = createRoute({
    method: "post",
    path: "/medical-records/{id}/determination",
    tags: tag,
    summary: "Penetapan Fit to Work (Dokter, bukan pembuat record)",
    security,
    middleware: guard(deps, "medical.verify"),
    request: {
      params: IdParam,
      headers: IfMatch,
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                fitness_status: Fitness,
                unfit_until: IsoDate.nullable().optional().openapi({ description: "Tanggal tinjau ulang, hanya UNFIT" }),
                follow_up_note: z
                  .string()
                  .trim()
                  .max(300)
                  .optional()
                  .openapi({ description: "Tindak lanjut ringan non-diagnostik, wajib untuk FIT_WITH_CONDITION" }),
                follow_up_due: IsoDate.optional(),
                restrictions: z.array(RestrictionInput).max(10).default([]),
                comment: z.string().trim().max(500).optional(),
              })
              .openapi("MedicalDetermination"),
          },
        },
        required: true,
      },
    },
    responses: {
      200: json(ok(MedicalRecord), "Ditetapkan"),
      ...errs,
      403: json(ErrorResponse, "FORBIDDEN, SEPARATION_OF_DUTIES"),
    },
  });
  v1.openapi(determine, async (c) => {
    const { id } = c.req.valid("param");
    const expected = parseIfMatch(c.req.valid("header")["if-match"]);
    const b = c.req.valid("json");
    const me = c.get("identity").userId;
    if (b.fitness_status === "FIT_WITH_RESTRICTION" && b.restrictions.length === 0)
      return respondFailure(c, new ApiFailure("RESTRICTION_REQUIRED", [{ field: "restrictions", issue: "required" }]));
    if (b.fitness_status !== "FIT_WITH_RESTRICTION" && b.restrictions.length > 0)
      return respondFailure(c, new ApiFailure("RESTRICTION_NOT_ALLOWED", [{ field: "restrictions", issue: "not_allowed" }]));
    const conditional = b.fitness_status === "FIT_WITH_CONDITION";
    if (conditional && (!b.follow_up_note || !b.follow_up_due))
      return respondFailure(
        c,
        new ApiFailure("FOLLOW_UP_REQUIRED", [
          ...(b.follow_up_note ? [] : [{ field: "follow_up_note", issue: "required" }]),
          ...(b.follow_up_due ? [] : [{ field: "follow_up_due", issue: "required" }]),
        ]),
      );
    if (!conditional && (b.follow_up_note || b.follow_up_due))
      return respondFailure(c, new ApiFailure("VALIDATION_ERROR", [{ field: "follow_up_note", issue: "only_for_condition" }]));
    if (b.fitness_status !== "UNFIT" && b.unfit_until)
      return respondFailure(c, new ApiFailure("VALIDATION_ERROR", [{ field: "unfit_until", issue: "only_for_unfit" }]));
    for (const [i, rs] of b.restrictions.entries())
      if (rs.valid_until && rs.valid_until < rs.valid_from)
        return respondFailure(
          c,
          new ApiFailure("INVALID_DATE_RANGE", [{ field: `restrictions[${i}].valid_until`, issue: "before_start" }]),
        );
    const r = await run(
      c,
      deps,
      async (tx) => {
        const cur = await tx.query<{ version: number; verification_status: string; created_by: string }>(
          "select version, verification_status, created_by from medical_record where id = $1",
          [id],
        );
        const row = cur.rows[0];
        if (!row) throw new ApiFailure("NOT_FOUND");
        if (expected !== row.version) throw new ApiFailure("VERSION_CONFLICT", undefined, { current_version: row.version });
        if (row.verification_status !== "PENDING")
          throw new ApiFailure("INVALID_STATE_TRANSITION", [{ field: "verification_status", issue: row.verification_status }]);
        if (row.created_by === me) throw new ApiFailure("SEPARATION_OF_DUTIES");
        const res = await tx.query(
          `update medical_record set verification_status = 'VERIFIED', fitness_status = $3, unfit_until = $4, verified_by = $5,
             verified_at = now(), determination_comment = $6, rejection_reason = null, follow_up_note = $7, follow_up_due = $8
           where id = $1 and version = $2`,
          [
            id,
            row.version,
            b.fitness_status,
            b.unfit_until ?? null,
            me,
            b.comment || null,
            conditional ? b.follow_up_note : null,
            conditional ? b.follow_up_due : null,
          ],
        );
        if (res.rowCount === 0) throw new ApiFailure("SCOPE_DENIED");
        const org = c.get("identity").organizationId;
        for (const rs of b.restrictions)
          await tx.query(
            `insert into medical_restriction (organization_id, medical_record_id, restriction_code, operational_description,
               valid_from, valid_until, created_by) values ($1, $2, $3, $4, $5, $6, $7)`,
            [org, id, rs.restriction_code, rs.operational_description, rs.valid_from, rs.valid_until ?? null, me],
          );
        return loadOne(tx, id, me, true);
      },
      { map: mapMedicalError },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return respondOne(c, r);
  });

  const reject = createRoute({
    method: "post",
    path: "/medical-records/{id}/reject",
    tags: tag,
    summary: "Menolak record MCU (Dokter, alasan wajib)",
    security,
    middleware: guard(deps, "medical.verify"),
    request: {
      params: IdParam,
      headers: IfMatch,
      body: {
        content: {
          "application/json": { schema: z.object({ reason: z.string().trim().max(500).optional() }).openapi("MedicalReject") },
        },
        required: true,
      },
    },
    responses: { 200: json(ok(MedicalRecord), "Ditolak"), ...errs, 403: json(ErrorResponse, "FORBIDDEN, SEPARATION_OF_DUTIES") },
  });
  v1.openapi(reject, async (c) => {
    const { id } = c.req.valid("param");
    const expected = parseIfMatch(c.req.valid("header")["if-match"]);
    const reason = c.req.valid("json").reason?.trim();
    const me = c.get("identity").userId;
    if (!reason) return respondFailure(c, new ApiFailure("REASON_REQUIRED", [{ field: "reason", issue: "required" }]));
    const r = await run(
      c,
      deps,
      async (tx) => {
        const cur = await tx.query<{ version: number; verification_status: string; created_by: string }>(
          "select version, verification_status, created_by from medical_record where id = $1",
          [id],
        );
        const row = cur.rows[0];
        if (!row) throw new ApiFailure("NOT_FOUND");
        if (expected !== row.version) throw new ApiFailure("VERSION_CONFLICT", undefined, { current_version: row.version });
        if (row.verification_status !== "PENDING") throw new ApiFailure("INVALID_STATE_TRANSITION");
        if (row.created_by === me) throw new ApiFailure("SEPARATION_OF_DUTIES");
        const res = await tx.query(
          `update medical_record set verification_status = 'REJECTED', verified_by = $3, verified_at = now(), rejection_reason = $4
            where id = $1 and version = $2`,
          [id, row.version, me, reason],
        );
        if (res.rowCount === 0) throw new ApiFailure("SCOPE_DENIED");
        return loadOne(tx, id, me, true);
      },
      { map: mapMedicalError },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return respondOne(c, r);
  });

  const lift = createRoute({
    method: "post",
    path: "/medical-restrictions/{id}/lift",
    tags: tag,
    summary: "Mengakhiri pembatasan operasional lebih awal (Dokter, alasan wajib)",
    security,
    middleware: guard(deps, "medical.verify"),
    request: {
      params: IdParam,
      body: {
        content: {
          "application/json": { schema: z.object({ reason: z.string().trim().max(500).optional() }).openapi("MedicalLift") },
        },
        required: true,
      },
    },
    responses: { 200: json(ok(z.object({ id: z.uuid(), status: z.literal("LIFTED") })), "Diakhiri"), ...errs },
  });
  v1.openapi(lift, async (c) => {
    const { id } = c.req.valid("param");
    const reason = c.req.valid("json").reason?.trim();
    if (!reason) return respondFailure(c, new ApiFailure("REASON_REQUIRED", [{ field: "reason", issue: "required" }]));
    const r = await run(
      c,
      deps,
      async (tx) => {
        const cur = await tx.query<{ status: string }>("select status from medical_restriction where id = $1", [id]);
        if (!cur.rows[0]) throw new ApiFailure("NOT_FOUND");
        if (cur.rows[0].status !== "ACTIVE") throw new ApiFailure("INVALID_STATE_TRANSITION");
        const res = await tx.query(
          "update medical_restriction set status = 'LIFTED', lift_reason = $2, lifted_by = $3, lifted_at = now() where id = $1",
          [id, reason, c.get("identity").userId],
        );
        if (res.rowCount === 0) throw new ApiFailure("SCOPE_DENIED");
        return { id, status: "LIFTED" as const };
      },
      { map: mapMedicalError },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return c.json({ success: true, data: r, request_id: c.get("requestId") }, 200);
  });

  // ---------------------------------------------------------------- otorisasi akses detail (HSE Manager)
  const Grant = z
    .object({
      id: z.uuid(),
      medical_record_id: z.uuid(),
      grantee_user_id: z.uuid(),
      grantee_name: z.string().nullable(),
      granted_by_name: z.string().nullable(),
      reason: z.string(),
      starts_at: z.string(),
      expires_at: z.string(),
      revoked_at: z.string().nullable(),
      active: z.boolean(),
    })
    .openapi("MedicalAccessGrant");
  const GRANT_SELECT = `select g.id, g.medical_record_id, g.grantee_user_id, ge.full_name as grantee_name, gb.full_name as granted_by_name,
      g.reason, g.starts_at, g.expires_at, g.revoked_at, (g.revoked_at is null and g.expires_at > now()) as active
    from medical_access_grant g left join user_profile ge on ge.id = g.grantee_user_id
    left join user_profile gb on gb.id = g.granted_by`;

  const grantees = createRoute({
    method: "get",
    path: "/medical-access-grantees",
    tags: tag,
    summary: "Pengguna yang dapat menerima otorisasi akses detail medis (HSE Manager)",
    security,
    middleware: guard(deps, "medical.verify"),
    responses: { 200: json(list(z.object({ id: z.uuid(), full_name: z.string() })), "Penerima"), ...baseErrors },
  });
  v1.openapi(grantees, async (c) => {
    const r = await run(c, deps, async (tx) => {
      // fungsi definer terbatas: hanya id dan nama pemegang medical.read_detail LIMITED
      const res = await tx.query("select id, full_name from app.medical_grantees()");
      return res.rows as Row[];
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return listBody(c, r);
  });

  const listGrants = createRoute({
    method: "get",
    path: "/medical-records/{id}/access-grants",
    tags: tag,
    summary: "Otorisasi akses detail pada record",
    security,
    middleware: guard(deps, "medical.verify"),
    request: { params: IdParam },
    responses: { 200: json(list(Grant), "Otorisasi"), ...baseErrors },
  });
  v1.openapi(listGrants, async (c) => {
    const r = await run(
      c,
      deps,
      async (tx) =>
        (await tx.query(`${GRANT_SELECT} where g.medical_record_id = $1 order by g.created_at desc`, [c.req.valid("param").id]))
          .rows as Row[],
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return listBody(c, r);
  });

  const addGrant = createRoute({
    method: "post",
    path: "/medical-records/{id}/access-grants",
    tags: tag,
    summary: "Memberi otorisasi akses detail berbatas waktu (<= 24 jam) kepada HSE Manager",
    security,
    middleware: guard(deps, "medical.verify"),
    request: {
      params: IdParam,
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                grantee_user_id: z.uuid(),
                reason: z.string().trim().min(MIN_REASON).max(500),
                hours: z.number().int().min(1).max(24).default(24),
              })
              .openapi("MedicalAccessGrantCreate"),
          },
        },
        required: true,
      },
    },
    responses: { 201: json(ok(Grant), "Diberikan"), ...errs },
  });
  v1.openapi(addGrant, async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const identity = c.get("identity");
    const r = await run(
      c,
      deps,
      async (tx) => {
        if (!(await tx.query("select 1 from medical_record where id = $1", [id])).rows[0]) throw new ApiFailure("NOT_FOUND");
        const ins = await tx.query<{ id: string }>(
          `insert into medical_access_grant (organization_id, medical_record_id, grantee_user_id, granted_by, reason, expires_at)
           values ($1, $2, $3, $4, $5, now() + make_interval(hours => $6)) returning id`,
          [identity.organizationId, id, b.grantee_user_id, identity.userId, b.reason, b.hours],
        );
        return (await tx.query(`${GRANT_SELECT} where g.id = $1`, [ins.rows[0]?.id])).rows[0] as Row;
      },
      { map: mapMedicalError },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return c.json({ success: true, data: serialize(r), request_id: c.get("requestId") }, 201);
  });

  const revokeGrant = createRoute({
    method: "post",
    path: "/medical-access-grants/{id}/revoke",
    tags: tag,
    summary: "Mencabut otorisasi akses detail",
    security,
    middleware: guard(deps, "medical.verify"),
    request: { params: IdParam },
    responses: { 200: json(ok(Grant), "Dicabut"), ...errs },
  });
  v1.openapi(revokeGrant, async (c) => {
    const { id } = c.req.valid("param");
    const r = await run(
      c,
      deps,
      async (tx) => {
        const res = await tx.query("update medical_access_grant set revoked_at = now() where id = $1 and revoked_at is null", [
          id,
        ]);
        if (res.rowCount === 0) throw new ApiFailure("NOT_FOUND");
        return (await tx.query(`${GRANT_SELECT} where g.id = $1`, [id])).rows[0] as Row;
      },
      { map: mapMedicalError },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return c.json({ success: true, data: serialize(r), request_id: c.get("requestId") }, 200);
  });
}

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
  guardSelf,
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
 * Otorisasi Kerja pekerja (API-006 §3-§6, SRS-WF005, DB-003 §2.1/§2.2/§5). Bukan Permit To Work (B-04).
 * - Record baru PENDING; data inti berubah pada VERIFIED/REJECTED -> PENDING (pemicu DB).
 * - verify/reject hanya dari PENDING, pemverifikasi bukan pembuat (403 SEPARATION_OF_DUTIES), HSE Officer (verify LIMITED) tidak.
 * - suspend/revoke/reinstate: authorization.verify penuh (HSE Manager), alasan wajib; REVOKED akhir (pemicu DB).
 * - Dokumen: satu berkas CLEAN milik pengunggah (file_id), unduh lewat document-url bertanda tangan pendek, teraudit.
 * - WORKER authorization.update SELF: mengajukan miliknya sendiri; tidak memverifikasi atau membekukan.
 * Belum di M3.3: evaluasi readiness (AUTH-API-011, M4), notifikasi pembekuan ke pekerja/Supervisor (menyusul M3.6),
 * AUTHORIZATION_TYPE_IN_USE (Requirement Profile, M4), Idempotency-Key pada POST.
 */

export type AuthorizationDeps = Deps & { storage?: FileStorage | undefined };

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const OptText = (max: number) => z.string().trim().max(max).nullable().optional();
export const EXPIRING_SOON_DAYS = 30;

const WorkerAuthorization = z
  .object({
    id: z.uuid(),
    worker_id: z.uuid(),
    site_id: z.uuid(),
    worker_name: z.string().nullable(),
    sho_id: z.string().nullable(),
    authorization_type: z.object({
      id: z.uuid(),
      name: z.string().nullable(),
      code: z.string().nullable(),
      requires_work_scope: z.boolean().nullable(),
    }),
    authorization_number: z.string().nullable(),
    issuer: z.string().nullable(),
    work_scope: z.string().nullable(),
    restriction_note: z.string().nullable(),
    valid_from: z.string(),
    valid_until: z.string().nullable(),
    has_document: z.boolean(),
    verification_status: z.enum(["PENDING", "VERIFIED", "REJECTED"]),
    suspension_status: z.enum(["NONE", "SUSPENDED", "REVOKED"]),
    validity_status: z.enum(["VALID", "EXPIRING_SOON", "EXPIRED", "PENDING_VERIFICATION", "REJECTED", "SUSPENDED"]),
    verified_by_name: z.string().nullable(),
    verified_at: z.string().nullable(),
    verification_comment: z.string().nullable(),
    rejection_reason: z.string().nullable(),
    suspended_by_name: z.string().nullable(),
    suspended_at: z.string().nullable(),
    suspension_reason: z.string().nullable(),
    created_by: z.uuid(),
    created_by_name: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    version: z.number().int(),
    can_verify: z.boolean(),
  })
  .openapi("WorkerAuthorization");

const validity = `case
    when wa.suspension_status <> 'NONE' then 'SUSPENDED'
    when wa.verification_status = 'REJECTED' then 'REJECTED'
    when wa.verification_status = 'PENDING' then 'PENDING_VERIFICATION'
    when wa.valid_until is not null and wa.valid_until < app.site_today(wa.site_id) then 'EXPIRED'
    when wa.valid_until is not null and wa.valid_until <= app.site_today(wa.site_id) + ${EXPIRING_SOON_DAYS} then 'EXPIRING_SOON'
    else 'VALID' end`;

/** $1 = pemanggil, $2 = punya authorization.verify (FULL/TEAM). */
const SELECT = `select wa.id, wa.worker_id, wa.site_id, w.full_name as worker_name, w.sho_id,
    json_build_object('id', wa.authorization_type_id, 'name', t.name, 'code', t.code, 'requires_work_scope', t.requires_work_scope)
      as authorization_type,
    wa.authorization_number, wa.issuer, wa.work_scope, wa.restriction_note,
    wa.valid_from::text as valid_from, wa.valid_until::text as valid_until, (wa.file_id is not null) as has_document,
    wa.verification_status, wa.suspension_status, ${validity} as validity_status,
    vb.full_name as verified_by_name, wa.verified_at, wa.verification_comment, wa.rejection_reason,
    sb.full_name as suspended_by_name, wa.suspended_at, wa.suspension_reason,
    wa.created_by, cb.full_name as created_by_name, wa.created_at, wa.updated_at, wa.version,
    (wa.verification_status = 'PENDING' and wa.suspension_status <> 'REVOKED' and wa.created_by <> $1::uuid and $2::boolean) as can_verify
  from worker_authorization wa
  left join authorization_type t on t.id = wa.authorization_type_id
  left join worker w on w.id = wa.worker_id
  left join user_profile vb on vb.id = wa.verified_by
  left join user_profile sb on sb.id = wa.suspended_by
  left join user_profile cb on cb.id = wa.created_by`;

const IdParam = z.object({ id: z.uuid() });
const WorkerParam = z.object({ worker_id: z.uuid() });

const Fields = {
  authorization_number: OptText(100),
  issuer: OptText(150),
  work_scope: OptText(500),
  restriction_note: OptText(500),
  file_id: z.uuid().nullable().optional(),
};

function mapAuthorizationError(e: { code?: string; message?: string; constraint?: string }): ApiFailure | undefined {
  const msg = e.message ?? "";
  if (e.code === "23514") {
    if (msg.startsWith("INVALID_STATE_TRANSITION")) return new ApiFailure("INVALID_STATE_TRANSITION");
    if (msg.startsWith("FILE_NOT_CLEAN")) return new ApiFailure("FILE_NOT_CLEAN", [{ field: "file_id", issue: "not_clean" }]);
    if (e.constraint === "worker_authorization_range_chk")
      return new ApiFailure("INVALID_DATE_RANGE", [{ field: "valid_until", issue: "before_valid_from" }]);
    if (e.constraint === "worker_authorization_sod_chk") return new ApiFailure("SEPARATION_OF_DUTIES");
    if (e.constraint === "worker_authorization_rejected_chk" || e.constraint === "worker_authorization_suspension_chk")
      return new ApiFailure("REASON_REQUIRED", [{ field: "reason", issue: "required" }]);
  }
  if (e.code === "23505" && e.constraint === "worker_authorization_file_uq")
    return new ApiFailure("DUPLICATE", [{ field: "file_id", issue: "already_used" }]);
  if (e.code === "23503") return new ApiFailure("VALIDATION_ERROR", [{ issue: "reference_not_found" }]);
  return undefined;
}

const canVerify = (c: Ctx) => c.get("identity").permissions.has("authorization.verify");

async function loadOne(tx: Tx, id: string, me: string, verifier: boolean): Promise<Row> {
  const r = await tx.query(`${SELECT} where wa.id = $3`, [me, verifier, id]);
  if (!r.rows[0]) throw new ApiFailure("NOT_FOUND");
  return r.rows[0] as Row;
}

/** Respons satu record + ETag. Status dinamis; kontrak per rute di `responses` (cast seperti respondFailure). */
function respondOne(c: Ctx, r: Row, status: 200 | 201 = 200): never {
  c.header("ETag", `"${r.version}"`);
  return c.json({ success: true, data: serialize(r), request_id: c.get("requestId") }, status) as never;
}

export function registerAuthorizations(v1: V1, deps: AuthorizationDeps) {
  const errs = {
    ...baseErrors,
    404: json(ErrorResponse, "NOT_FOUND (tidak ada atau di luar scope)"),
    409: json(ErrorResponse, "INVALID_STATE_TRANSITION, DUPLICATE"),
    412: json(ErrorResponse, "VERSION_CONFLICT (disertai current_version)"),
    422: json(ErrorResponse, "VALIDATION_ERROR, INVALID_DATE_RANGE, WORK_SCOPE_REQUIRED, REASON_REQUIRED, FILE_NOT_CLEAN"),
  };
  const tag = ["Work Authorization"];

  // ---------------------------------------------------------------- antrean verifikasi
  const queue = createRoute({
    method: "get",
    path: "/authorizations/pending-verification",
    tags: tag,
    summary: "Antrean verifikasi Otorisasi Kerja (PENDING, terlama dahulu)",
    security,
    middleware: guard(deps, "authorization.verify"),
    request: {
      query: z.object({
        site_id: z.uuid().optional(),
        authorization_type_id: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
    },
    responses: { 200: json(list(WorkerAuthorization), "Antrean"), ...baseErrors, 422: json(ErrorResponse, "VALIDATION_ERROR") },
  });
  v1.openapi(queue, async (c) => {
    const q = c.req.valid("query");
    const r = await run(c, deps, async (tx) => {
      const params: unknown[] = [c.get("identity").userId, true];
      const where = ["wa.verification_status = 'PENDING'", "wa.suspension_status <> 'REVOKED'"];
      if (q.site_id) {
        params.push(q.site_id);
        where.push(`wa.site_id = $${params.length}`);
      }
      if (q.authorization_type_id) {
        params.push(q.authorization_type_id);
        where.push(`wa.authorization_type_id = $${params.length}`);
      }
      const res = await tx.query(
        `${SELECT} where ${where.join(" and ")} order by wa.updated_at, wa.id limit ${q.limit + 1}`,
        params,
      );
      return res.rows as Row[];
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return c.json(
      {
        success: true,
        data: r.slice(0, q.limit).map(serialize),
        pagination: { limit: q.limit, next_cursor: null, has_more: r.length > q.limit },
        request_id: c.get("requestId"),
      },
      200,
    );
  });

  // ---------------------------------------------------------------- milik pekerja
  const listRoute = createRoute({
    method: "get",
    path: "/workers/{worker_id}/authorizations",
    tags: tag,
    summary: "Otorisasi Kerja pekerja (semua riwayat, terbaru dahulu)",
    security,
    middleware: guardSelf(deps, "authorization.read"),
    request: { params: WorkerParam },
    responses: { 200: json(list(WorkerAuthorization), "Otorisasi"), ...baseErrors, 404: json(ErrorResponse, "NOT_FOUND") },
  });
  v1.openapi(listRoute, async (c) => {
    const { worker_id } = c.req.valid("param");
    const r = await run(c, deps, async (tx) => {
      const res = await tx.query(`${SELECT} where wa.worker_id = $3 order by wa.valid_from desc, wa.created_at desc limit 501`, [
        c.get("identity").userId,
        canVerify(c),
        worker_id,
      ]);
      if (res.rows.length === 0 && !(await tx.query("select 1 from worker where id = $1", [worker_id])).rows[0])
        throw new ApiFailure("NOT_FOUND");
      return res.rows as Row[];
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return c.json(
      {
        success: true,
        data: r.slice(0, 500).map(serialize),
        pagination: { limit: 500, next_cursor: null, has_more: r.length > 500 },
        request_id: c.get("requestId"),
      },
      200,
    );
  });

  const createRec = createRoute({
    method: "post",
    path: "/workers/{worker_id}/authorizations",
    tags: tag,
    summary: "Mengajukan Otorisasi Kerja pekerja (PENDING)",
    security,
    middleware: guardSelf(deps, "authorization.update"),
    request: {
      params: WorkerParam,
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                authorization_type_id: z.uuid(),
                valid_from: IsoDate,
                valid_until: IsoDate.nullable().optional(),
                ...Fields,
              })
              .openapi("WorkerAuthorizationCreate"),
          },
        },
        required: true,
      },
    },
    responses: { 201: json(ok(WorkerAuthorization), "Diajukan"), ...errs },
  });
  v1.openapi(createRec, async (c) => {
    const { worker_id } = c.req.valid("param");
    const b = c.req.valid("json");
    const identity = c.get("identity");
    const orgId = identity.organizationId;
    if (!orgId) return respondFailure(c, new ApiFailure("FORBIDDEN"));
    if (b.valid_until && b.valid_until < b.valid_from)
      return respondFailure(c, new ApiFailure("INVALID_DATE_RANGE", [{ field: "valid_until", issue: "before_start" }]));
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
        if (b.valid_from > wr.today) throw new ApiFailure("VALIDATION_ERROR", [{ field: "valid_from", issue: "in_future" }]);
        const t = await tx.query<{ status: string; requires_work_scope: boolean }>(
          "select status, requires_work_scope from authorization_type where id = $1",
          [b.authorization_type_id],
        );
        const tr = t.rows[0];
        if (tr?.status !== "ACTIVE")
          throw new ApiFailure("VALIDATION_ERROR", [{ field: "authorization_type_id", issue: tr ? "inactive" : "not_found" }]);
        if (tr.requires_work_scope && !b.work_scope?.trim())
          throw new ApiFailure("WORK_SCOPE_REQUIRED", [{ field: "work_scope", issue: "required" }]);
        const ins = await tx.query<{ id: string }>(
          `insert into worker_authorization (organization_id, site_id, worker_id, authorization_type_id, authorization_number, issuer,
             work_scope, restriction_note, valid_from, valid_until, file_id, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
          [
            orgId,
            wr.site_id,
            worker_id,
            b.authorization_type_id,
            b.authorization_number || null,
            b.issuer || null,
            b.work_scope || null,
            b.restriction_note || null,
            b.valid_from,
            b.valid_until ?? null,
            b.file_id ?? null,
            identity.userId,
          ],
        );
        return loadOne(tx, ins.rows[0]?.id as string, identity.userId, canVerify(c));
      },
      { map: mapAuthorizationError },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("Location", `/api/v1/worker-authorizations/${r.id}`);
    return respondOne(c, r, 201);
  });

  const getRec = createRoute({
    method: "get",
    path: "/worker-authorizations/{id}",
    tags: tag,
    summary: "Detail Otorisasi Kerja pekerja",
    security,
    middleware: guardSelf(deps, "authorization.read"),
    request: { params: IdParam },
    responses: { 200: json(ok(WorkerAuthorization), "Otorisasi"), ...baseErrors, 404: json(ErrorResponse, "NOT_FOUND") },
  });
  v1.openapi(getRec, async (c) => {
    const r = await run(c, deps, (tx) => loadOne(tx, c.req.valid("param").id, c.get("identity").userId, canVerify(c)));
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return respondOne(c, r);
  });

  const patchRec = createRoute({
    method: "patch",
    path: "/worker-authorizations/{id}",
    tags: tag,
    summary: "Mengubah Otorisasi Kerja (data inti pada record terverifikasi/ditolak -> PENDING)",
    security,
    middleware: guardSelf(deps, "authorization.update"),
    request: {
      params: IdParam,
      headers: IfMatch,
      body: {
        content: {
          "application/json": {
            schema: z
              .object({ valid_from: IsoDate.optional(), valid_until: IsoDate.nullable().optional(), ...Fields })
              .openapi("WorkerAuthorizationPatch"),
          },
        },
        required: true,
      },
    },
    responses: { 200: json(ok(WorkerAuthorization), "Otorisasi"), ...errs },
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
        const cur = await tx.query<{
          version: number;
          valid_from: string;
          valid_until: string | null;
          work_scope: string | null;
          requires_work_scope: boolean;
          today: string;
        }>(
          `select wa.version, wa.valid_from::text as valid_from, wa.valid_until::text as valid_until, wa.work_scope,
                  t.requires_work_scope, app.site_today(wa.site_id)::text as today
             from worker_authorization wa join authorization_type t on t.id = wa.authorization_type_id where wa.id = $1`,
          [id],
        );
        const row = cur.rows[0];
        if (!row) throw new ApiFailure("NOT_FOUND");
        if (expected !== row.version) throw new ApiFailure("VERSION_CONFLICT", undefined, { current_version: row.version });
        const from = (b.valid_from as string | undefined) ?? row.valid_from;
        const until = b.valid_until === undefined ? row.valid_until : (b.valid_until as string | null);
        if (until && until < from) throw new ApiFailure("INVALID_DATE_RANGE", [{ field: "valid_until", issue: "before_start" }]);
        if (b.valid_from && (b.valid_from as string) > row.today)
          throw new ApiFailure("VALIDATION_ERROR", [{ field: "valid_from", issue: "in_future" }]);
        const scope = b.work_scope === undefined ? row.work_scope : (b.work_scope as string | null);
        if (row.requires_work_scope && !scope?.trim())
          throw new ApiFailure("WORK_SCOPE_REQUIRED", [{ field: "work_scope", issue: "required" }]);
        const keys = [
          "valid_from",
          "valid_until",
          "authorization_number",
          "issuer",
          "work_scope",
          "restriction_note",
          "file_id",
        ].filter((k) => b[k] !== undefined);
        if (keys.length) {
          const res = await tx.query(
            `update worker_authorization set ${keys.map((k, i) => `${k} = $${i + 3}`).join(", ")} where id = $1 and version = $2`,
            [id, row.version, ...keys.map((k) => (b[k] === "" ? null : b[k]))],
          );
          if (res.rowCount === 0) throw new ApiFailure("SCOPE_DENIED");
        }
        return loadOne(tx, id, me, canVerify(c));
      },
      { map: mapAuthorizationError },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return respondOne(c, r);
  });

  // ---------------------------------------------------------------- verifikasi dan pembekuan
  type Action = "verify" | "reject" | "suspend" | "revoke" | "reinstate";
  const ACTIONS: Record<Action, { summary: string; needsReason: boolean }> = {
    verify: { summary: "Memverifikasi Otorisasi Kerja (bukan pembuat)", needsReason: false },
    reject: { summary: "Menolak Otorisasi Kerja (alasan wajib)", needsReason: true },
    suspend: { summary: "Membekukan Otorisasi Kerja (HSE Manager, alasan wajib)", needsReason: true },
    revoke: { summary: "Mencabut Otorisasi Kerja, bersifat akhir (HSE Manager, alasan wajib)", needsReason: true },
    reinstate: { summary: "Memulihkan Otorisasi Kerja yang dibekukan (HSE Manager, alasan wajib)", needsReason: true },
  };
  for (const action of Object.keys(ACTIONS) as Action[]) {
    const spec = ACTIONS[action];
    const route = createRoute({
      method: "post",
      path: `/worker-authorizations/{id}/${action}`,
      tags: tag,
      summary: spec.summary,
      security,
      middleware: guard(deps, "authorization.verify"),
      request: {
        params: IdParam,
        headers: IfMatch,
        body: {
          content: {
            "application/json": {
              schema: z
                .object({ comment: z.string().trim().max(500).optional(), reason: z.string().trim().max(500).optional() })
                .openapi("WorkerAuthorizationAction"),
            },
          },
          required: true,
        },
      },
      responses: {
        200: json(ok(WorkerAuthorization), "Hasil"),
        ...errs,
        403: json(ErrorResponse, "FORBIDDEN, SCOPE_DENIED, SEPARATION_OF_DUTIES"),
      },
    });
    v1.openapi(route, async (c) => {
      const { id } = c.req.valid("param");
      const expected = parseIfMatch(c.req.valid("header")["if-match"]);
      const b = c.req.valid("json");
      const me = c.get("identity").userId;
      const reason = b.reason?.trim();
      if (spec.needsReason && !reason)
        return respondFailure(c, new ApiFailure("REASON_REQUIRED", [{ field: "reason", issue: "required" }]));
      const r = await run(
        c,
        deps,
        async (tx) => {
          const cur = await tx.query<{
            version: number;
            verification_status: string;
            suspension_status: string;
            created_by: string;
          }>("select version, verification_status, suspension_status, created_by from worker_authorization where id = $1", [id]);
          const row = cur.rows[0];
          if (!row) throw new ApiFailure("NOT_FOUND");
          if (expected !== row.version) throw new ApiFailure("VERSION_CONFLICT", undefined, { current_version: row.version });
          const bad = (issue: string) => new ApiFailure("INVALID_STATE_TRANSITION", [{ issue }]);
          if (row.suspension_status === "REVOKED") throw bad("REVOKED");
          let sql: string;
          let params: unknown[];
          if (action === "verify" || action === "reject") {
            if (row.verification_status !== "PENDING") throw bad(row.verification_status);
            if (row.created_by === me) throw new ApiFailure("SEPARATION_OF_DUTIES");
            sql =
              action === "verify"
                ? `update worker_authorization set verification_status = 'VERIFIED', verified_by = $3, verified_at = now(),
                     verification_comment = $4, rejection_reason = null where id = $1 and version = $2`
                : `update worker_authorization set verification_status = 'REJECTED', verified_by = $3, verified_at = now(),
                     rejection_reason = $4, verification_comment = null where id = $1 and version = $2`;
            params = [id, row.version, me, action === "verify" ? b.comment?.trim() || null : reason];
          } else {
            const from = action === "reinstate" ? ["SUSPENDED"] : action === "suspend" ? ["NONE"] : ["NONE", "SUSPENDED"];
            if (!from.includes(row.suspension_status)) throw bad(row.suspension_status);
            const target = action === "suspend" ? "SUSPENDED" : action === "revoke" ? "REVOKED" : "NONE";
            sql = `update worker_authorization set suspension_status = $3, suspended_by = $4, suspended_at = now(),
                     suspension_reason = $5 where id = $1 and version = $2`;
            params = [id, row.version, target, me, reason];
          }
          const res = await tx.query(sql, params);
          if (res.rowCount === 0) throw new ApiFailure("SCOPE_DENIED");
          return loadOne(tx, id, me, canVerify(c));
        },
        {
          map: (e) => {
            // pemicu menolak pembekuan tanpa authorization.verify penuh di Site record
            if (e.code === "42501") return new ApiFailure("SCOPE_DENIED");
            return mapAuthorizationError(e);
          },
        },
      );
      if (r instanceof ApiFailure) return respondFailure(c, r);
      return respondOne(c, r);
    });
  }

  // ---------------------------------------------------------------- dokumen
  const doc = createRoute({
    method: "get",
    path: "/worker-authorizations/{id}/document-url",
    tags: tag,
    summary: "URL dokumen Otorisasi Kerja bertanda tangan berumur pendek (teraudit)",
    security,
    middleware: guardSelf(deps, "authorization.read"),
    request: { params: IdParam },
    responses: {
      200: json(ok(z.object({ url: z.string(), expires_in: z.number().int() })), "URL unduh"),
      ...baseErrors,
      404: json(ErrorResponse, "NOT_FOUND (tanpa dokumen atau di luar scope)"),
      422: json(ErrorResponse, "FILE_NOT_CLEAN"),
      503: json(ErrorResponse, "SERVICE_UNAVAILABLE (penyimpanan)"),
    },
  });
  v1.openapi(doc, async (c) => {
    const { id } = c.req.valid("param");
    const storage = deps.storage;
    if (!storage)
      return respondFailure(c, new ApiFailure("SERVICE_UNAVAILABLE", [{ field: "storage", issue: "not_configured" }]));
    const r = await run(c, deps, async (tx) => {
      const res = await tx.query<{
        site_id: string;
        bucket: string | null;
        object_path: string | null;
        original_name: string | null;
        scan_status: string | null;
      }>(
        `select wa.site_id, f.bucket, f.object_path, f.original_name, f.scan_status
           from worker_authorization wa left join file_object f on f.id = wa.file_id where wa.id = $1`,
        [id],
      );
      const row = res.rows[0];
      if (!row?.bucket || !row.object_path) throw new ApiFailure("NOT_FOUND");
      if (row.scan_status !== "CLEAN") throw new ApiFailure("FILE_NOT_CLEAN");
      const ttl = 300;
      await tx.query(
        "select app.audit_record('authorization.document_access', 'worker_authorization', $1, null, null, 'authorization.read', $2, 'SUCCESS', false)",
        [id, row.site_id],
      );
      try {
        return {
          url: await storage.createDownloadUrl(row.bucket, row.object_path, ttl, safeFileName(row.original_name ?? "otorisasi")),
          expires_in: ttl,
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
}

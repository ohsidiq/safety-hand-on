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
 * SIMPER pekerja (API-007 §3-§6, SRS-WF006, DB-003 §2.1/§2.2/§6) dan otorisasi per kelas alat (§4).
 * - Record baru PENDING dengan minimal satu otorisasi kelas alat (VR-WF006-006); data inti atau otorisasi kelas alat
 *   berubah pada VERIFIED/REJECTED -> PENDING (pemicu DB).
 * - Otorisasi kelas alat: dalam masa berlaku SIMPER induk (422 AUTHORIZATION_OUTSIDE_SIMPER_VALIDITY), satu per kelas
 *   (409 DUPLICATE), status ACTIVE/SUSPENDED/REVOKED oleh simper.verify penuh dengan alasan; REVOKED akhir.
 * - verify/reject hanya dari PENDING, pemverifikasi bukan pembuat (403 SEPARATION_OF_DUTIES), HSE Officer (verify LIMITED) tidak.
 * - suspend/revoke/reinstate: simper.verify penuh (HSE Manager), alasan wajib; REVOKED akhir (pemicu DB).
 * - Dokumen: satu berkas CLEAN milik pengunggah (file_id), unduh lewat document-url bertanda tangan pendek, teraudit.
 * - WORKER simper.update SELF: mengajukan miliknya sendiri; tidak memverifikasi atau membekukan.
 * Belum di M3.4: evaluasi readiness (SIM-API-011, M4), notifikasi pembekuan (M3.6), SIMPER_TYPE_IN_USE (Requirement
 * Profile, M4), Idempotency-Key pada POST.
 */

export type SimperDeps = Deps & { storage?: FileStorage | undefined };

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const OptText = (max: number) => z.string().trim().max(max).nullable().optional();
export const EXPIRING_SOON_DAYS = 30;

const ClassAuth = z
  .object({
    id: z.uuid(),
    simper_id: z.uuid(),
    equipment_class: z.object({ id: z.uuid(), name: z.string().nullable(), code: z.string().nullable() }),
    valid_from: z.string(),
    valid_until: z.string().nullable(),
    restriction_note: z.string().nullable(),
    status: z.enum(["ACTIVE", "SUSPENDED", "REVOKED"]),
    status_reason: z.string().nullable(),
    version: z.number().int(),
  })
  .openapi("SimperAuthorization");

const ClassAuthInput = z
  .object({
    equipment_class_id: z.uuid(),
    valid_from: IsoDate,
    valid_until: IsoDate.nullable().optional(),
    restriction_note: z.string().trim().max(500).nullable().optional(),
  })
  .openapi("SimperAuthorizationCreate");

const CLASS_AUTH_SELECT = `select a.id, a.simper_id, json_build_object('id', a.equipment_class_id, 'name', ec.name, 'code', ec.code)
    as equipment_class, a.valid_from::text as valid_from, a.valid_until::text as valid_until, a.restriction_note, a.status,
    a.status_reason, a.version
  from simper_authorization a left join equipment_class ec on ec.id = a.equipment_class_id`;

async function insertClassAuth(tx: Tx, orgId: string, simperId: string, me: string, a: z.infer<typeof ClassAuthInput>) {
  if (a.valid_until && a.valid_until < a.valid_from)
    throw new ApiFailure("INVALID_DATE_RANGE", [{ field: "authorizations.valid_until", issue: "before_start" }]);
  const ins = await tx.query<{ id: string }>(
    `insert into simper_authorization (organization_id, simper_id, equipment_class_id, valid_from, valid_until, restriction_note, created_by)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [orgId, simperId, a.equipment_class_id, a.valid_from, a.valid_until ?? null, a.restriction_note || null, me],
  );
  return ins.rows[0]?.id as string;
}

const Simper = z
  .object({
    id: z.uuid(),
    worker_id: z.uuid(),
    site_id: z.uuid(),
    worker_name: z.string().nullable(),
    sho_id: z.string().nullable(),
    simper_type: z.object({
      id: z.uuid(),
      name: z.string().nullable(),
      code: z.string().nullable(),
    }),
    simper_number: z.string().nullable(),
    issuer: z.string().nullable(),
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
    equipment_authorizations: z.array(ClassAuth),
  })
  .openapi("Simper");

const validity = `case
    when s.suspension_status <> 'NONE' then 'SUSPENDED'
    when s.verification_status = 'REJECTED' then 'REJECTED'
    when s.verification_status = 'PENDING' then 'PENDING_VERIFICATION'
    when s.valid_until is not null and s.valid_until < app.site_today(s.site_id) then 'EXPIRED'
    when s.valid_until is not null and s.valid_until <= app.site_today(s.site_id) + ${EXPIRING_SOON_DAYS} then 'EXPIRING_SOON'
    else 'VALID' end`;

/** $1 = pemanggil, $2 = punya simper.verify (FULL/TEAM). */
const SELECT = `select s.id, s.worker_id, s.site_id, w.full_name as worker_name, w.sho_id,
    json_build_object('id', s.simper_type_id, 'name', t.name, 'code', t.code)
      as simper_type,
    s.simper_number, s.issuer, s.restriction_note,
    s.valid_from::text as valid_from, s.valid_until::text as valid_until, (s.file_id is not null) as has_document,
    s.verification_status, s.suspension_status, ${validity} as validity_status,
    vb.full_name as verified_by_name, s.verified_at, s.verification_comment, s.rejection_reason,
    sb.full_name as suspended_by_name, s.suspended_at, s.suspension_reason,
    s.created_by, cb.full_name as created_by_name, s.created_at, s.updated_at, s.version,
    (s.verification_status = 'PENDING' and s.suspension_status <> 'REVOKED' and s.created_by <> $1::uuid and $2::boolean) as can_verify,
    coalesce((select json_agg(x order by x.status, x.valid_from) from (${CLASS_AUTH_SELECT} where a.simper_id = s.id) x), '[]'::json)
      as equipment_authorizations
  from simper s
  left join simper_type t on t.id = s.simper_type_id
  left join worker w on w.id = s.worker_id
  left join user_profile vb on vb.id = s.verified_by
  left join user_profile sb on sb.id = s.suspended_by
  left join user_profile cb on cb.id = s.created_by`;

const IdParam = z.object({ id: z.uuid() });
const WorkerParam = z.object({ worker_id: z.uuid() });

const Fields = {
  simper_number: OptText(100),
  issuer: OptText(150),
  restriction_note: OptText(500),
  file_id: z.uuid().nullable().optional(),
};

function mapSimperError(e: { code?: string; message?: string; constraint?: string }): ApiFailure | undefined {
  const msg = e.message ?? "";
  if (e.code === "23514") {
    if (msg.startsWith("INVALID_STATE_TRANSITION")) return new ApiFailure("INVALID_STATE_TRANSITION");
    if (msg.startsWith("FILE_NOT_CLEAN")) return new ApiFailure("FILE_NOT_CLEAN", [{ field: "file_id", issue: "not_clean" }]);
    if (msg.startsWith("AUTHORIZATION_OUTSIDE_SIMPER_VALIDITY"))
      return new ApiFailure("AUTHORIZATION_OUTSIDE_SIMPER_VALIDITY", [
        { field: "valid_until", issue: "outside_simper_validity" },
      ]);
    if (e.constraint === "simper_authorization_range_chk")
      return new ApiFailure("INVALID_DATE_RANGE", [{ field: "authorizations.valid_until", issue: "before_valid_from" }]);
    if (e.constraint === "simper_authorization_status_chk")
      return new ApiFailure("REASON_REQUIRED", [{ field: "reason", issue: "required" }]);
    if (e.constraint === "simper_range_chk")
      return new ApiFailure("INVALID_DATE_RANGE", [{ field: "valid_until", issue: "before_valid_from" }]);
    if (e.constraint === "simper_sod_chk") return new ApiFailure("SEPARATION_OF_DUTIES");
    if (e.constraint === "simper_rejected_chk" || e.constraint === "simper_suspension_chk")
      return new ApiFailure("REASON_REQUIRED", [{ field: "reason", issue: "required" }]);
  }
  if (e.code === "23505" && e.constraint === "simper_authorization_class_uq")
    return new ApiFailure("DUPLICATE", [{ field: "equipment_class_id", issue: "already_authorized" }]);
  if (e.code === "23505" && e.constraint === "simper_file_uq")
    return new ApiFailure("DUPLICATE", [{ field: "file_id", issue: "already_used" }]);
  if (e.code === "23503") return new ApiFailure("VALIDATION_ERROR", [{ issue: "reference_not_found" }]);
  return undefined;
}

const canVerify = (c: Ctx) => c.get("identity").permissions.has("simper.verify");

async function loadOne(tx: Tx, id: string, me: string, verifier: boolean): Promise<Row> {
  const r = await tx.query(`${SELECT} where s.id = $3`, [me, verifier, id]);
  if (!r.rows[0]) throw new ApiFailure("NOT_FOUND");
  return r.rows[0] as Row;
}

/** Respons satu record + ETag. Status dinamis; kontrak per rute di `responses` (cast seperti respondFailure). */
function respondOne(c: Ctx, r: Row, status: 200 | 201 = 200): never {
  c.header("ETag", `"${r.version}"`);
  return c.json({ success: true, data: serialize(r), request_id: c.get("requestId") }, status) as never;
}

export function registerSimpers(v1: V1, deps: SimperDeps) {
  const errs = {
    ...baseErrors,
    404: json(ErrorResponse, "NOT_FOUND (tidak ada atau di luar scope)"),
    409: json(ErrorResponse, "INVALID_STATE_TRANSITION, DUPLICATE"),
    412: json(ErrorResponse, "VERSION_CONFLICT (disertai current_version)"),
    422: json(
      ErrorResponse,
      "VALIDATION_ERROR, INVALID_DATE_RANGE, AUTHORIZATION_OUTSIDE_SIMPER_VALIDITY, REASON_REQUIRED, FILE_NOT_CLEAN",
    ),
  };
  const tag = ["SIMPER"];

  // ---------------------------------------------------------------- antrean verifikasi
  const queue = createRoute({
    method: "get",
    path: "/simpers/pending-verification",
    tags: tag,
    summary: "Antrean verifikasi SIMPER (PENDING, terlama dahulu)",
    security,
    middleware: guard(deps, "simper.verify"),
    request: {
      query: z.object({
        site_id: z.uuid().optional(),
        simper_type_id: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
    },
    responses: { 200: json(list(Simper), "Antrean"), ...baseErrors, 422: json(ErrorResponse, "VALIDATION_ERROR") },
  });
  v1.openapi(queue, async (c) => {
    const q = c.req.valid("query");
    const r = await run(c, deps, async (tx) => {
      const params: unknown[] = [c.get("identity").userId, true];
      const where = ["s.verification_status = 'PENDING'", "s.suspension_status <> 'REVOKED'"];
      if (q.site_id) {
        params.push(q.site_id);
        where.push(`s.site_id = $${params.length}`);
      }
      if (q.simper_type_id) {
        params.push(q.simper_type_id);
        where.push(`s.simper_type_id = $${params.length}`);
      }
      const res = await tx.query(
        `${SELECT} where ${where.join(" and ")} order by s.updated_at, s.id limit ${q.limit + 1}`,
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
    path: "/workers/{worker_id}/simpers",
    tags: tag,
    summary: "SIMPER pekerja (semua riwayat, terbaru dahulu)",
    security,
    middleware: guardSelf(deps, "simper.read"),
    request: { params: WorkerParam },
    responses: { 200: json(list(Simper), "Otorisasi"), ...baseErrors, 404: json(ErrorResponse, "NOT_FOUND") },
  });
  v1.openapi(listRoute, async (c) => {
    const { worker_id } = c.req.valid("param");
    const r = await run(c, deps, async (tx) => {
      const res = await tx.query(`${SELECT} where s.worker_id = $3 order by s.valid_from desc, s.created_at desc limit 501`, [
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
    path: "/workers/{worker_id}/simpers",
    tags: tag,
    summary: "Mengajukan SIMPER pekerja (PENDING)",
    security,
    middleware: guardSelf(deps, "simper.update"),
    request: {
      params: WorkerParam,
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                simper_type_id: z.uuid(),
                valid_from: IsoDate,
                valid_until: IsoDate.nullable().optional(),
                ...Fields,
                authorizations: z.array(ClassAuthInput).min(1).max(10),
              })
              .openapi("SimperCreate"),
          },
        },
        required: true,
      },
    },
    responses: { 201: json(ok(Simper), "Diajukan"), ...errs },
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
        const t = await tx.query<{ status: string }>("select status from simper_type where id = $1", [b.simper_type_id]);
        const tr = t.rows[0];
        if (tr?.status !== "ACTIVE")
          throw new ApiFailure("VALIDATION_ERROR", [{ field: "simper_type_id", issue: tr ? "inactive" : "not_found" }]);
        const ins = await tx.query<{ id: string }>(
          `insert into simper (organization_id, site_id, worker_id, simper_type_id, simper_number, issuer,
             restriction_note, valid_from, valid_until, file_id, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
          [
            orgId,
            wr.site_id,
            worker_id,
            b.simper_type_id,
            b.simper_number || null,
            b.issuer || null,
            b.restriction_note || null,
            b.valid_from,
            b.valid_until ?? null,
            b.file_id ?? null,
            identity.userId,
          ],
        );
        const simperId = ins.rows[0]?.id as string;
        for (const a of b.authorizations) await insertClassAuth(tx, orgId, simperId, identity.userId, a);
        return loadOne(tx, simperId, identity.userId, canVerify(c));
      },
      { map: mapSimperError },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("Location", `/api/v1/simpers/${r.id}`);
    return respondOne(c, r, 201);
  });

  const getRec = createRoute({
    method: "get",
    path: "/simpers/{id}",
    tags: tag,
    summary: "Detail SIMPER pekerja",
    security,
    middleware: guardSelf(deps, "simper.read"),
    request: { params: IdParam },
    responses: { 200: json(ok(Simper), "Otorisasi"), ...baseErrors, 404: json(ErrorResponse, "NOT_FOUND") },
  });
  v1.openapi(getRec, async (c) => {
    const r = await run(c, deps, (tx) => loadOne(tx, c.req.valid("param").id, c.get("identity").userId, canVerify(c)));
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return respondOne(c, r);
  });

  const patchRec = createRoute({
    method: "patch",
    path: "/simpers/{id}",
    tags: tag,
    summary: "Mengubah SIMPER (data inti pada record terverifikasi/ditolak -> PENDING)",
    security,
    middleware: guardSelf(deps, "simper.update"),
    request: {
      params: IdParam,
      headers: IfMatch,
      body: {
        content: {
          "application/json": {
            schema: z
              .object({ valid_from: IsoDate.optional(), valid_until: IsoDate.nullable().optional(), ...Fields })
              .openapi("SimperPatch"),
          },
        },
        required: true,
      },
    },
    responses: { 200: json(ok(Simper), "Otorisasi"), ...errs },
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
          today: string;
        }>(
          `select s.version, s.valid_from::text as valid_from, s.valid_until::text as valid_until,
                  app.site_today(s.site_id)::text as today from simper s where s.id = $1`,
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
        const keys = ["valid_from", "valid_until", "simper_number", "issuer", "restriction_note", "file_id"].filter(
          (k) => b[k] !== undefined,
        );
        if (keys.length) {
          const res = await tx.query(
            `update simper set ${keys.map((k, i) => `${k} = $${i + 3}`).join(", ")} where id = $1 and version = $2`,
            [id, row.version, ...keys.map((k) => (b[k] === "" ? null : b[k]))],
          );
          if (res.rowCount === 0) throw new ApiFailure("SCOPE_DENIED");
        }
        return loadOne(tx, id, me, canVerify(c));
      },
      { map: mapSimperError },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return respondOne(c, r);
  });

  // ---------------------------------------------------------------- verifikasi dan pembekuan
  type Action = "verify" | "reject" | "suspend" | "revoke" | "reinstate";
  const ACTIONS: Record<Action, { summary: string; needsReason: boolean }> = {
    verify: { summary: "Memverifikasi SIMPER (bukan pembuat)", needsReason: false },
    reject: { summary: "Menolak SIMPER (alasan wajib)", needsReason: true },
    suspend: { summary: "Membekukan SIMPER (HSE Manager, alasan wajib)", needsReason: true },
    revoke: { summary: "Mencabut SIMPER, bersifat akhir (HSE Manager, alasan wajib)", needsReason: true },
    reinstate: { summary: "Memulihkan SIMPER yang dibekukan (HSE Manager, alasan wajib)", needsReason: true },
  };
  for (const action of Object.keys(ACTIONS) as Action[]) {
    const spec = ACTIONS[action];
    const route = createRoute({
      method: "post",
      path: `/simpers/{id}/${action}`,
      tags: tag,
      summary: spec.summary,
      security,
      middleware: guard(deps, "simper.verify"),
      request: {
        params: IdParam,
        headers: IfMatch,
        body: {
          content: {
            "application/json": {
              schema: z
                .object({ comment: z.string().trim().max(500).optional(), reason: z.string().trim().max(500).optional() })
                .openapi("SimperAction"),
            },
          },
          required: true,
        },
      },
      responses: {
        200: json(ok(Simper), "Hasil"),
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
          }>("select version, verification_status, suspension_status, created_by from simper where id = $1", [id]);
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
                ? `update simper set verification_status = 'VERIFIED', verified_by = $3, verified_at = now(),
                     verification_comment = $4, rejection_reason = null where id = $1 and version = $2`
                : `update simper set verification_status = 'REJECTED', verified_by = $3, verified_at = now(),
                     rejection_reason = $4, verification_comment = null where id = $1 and version = $2`;
            params = [id, row.version, me, action === "verify" ? b.comment?.trim() || null : reason];
          } else {
            const from = action === "reinstate" ? ["SUSPENDED"] : action === "suspend" ? ["NONE"] : ["NONE", "SUSPENDED"];
            if (!from.includes(row.suspension_status)) throw bad(row.suspension_status);
            const target = action === "suspend" ? "SUSPENDED" : action === "revoke" ? "REVOKED" : "NONE";
            sql = `update simper set suspension_status = $3, suspended_by = $4, suspended_at = now(),
                     suspension_reason = $5 where id = $1 and version = $2`;
            params = [id, row.version, target, me, reason];
          }
          const res = await tx.query(sql, params);
          if (res.rowCount === 0) throw new ApiFailure("SCOPE_DENIED");
          return loadOne(tx, id, me, canVerify(c));
        },
        {
          map: (e) => {
            // pemicu menolak pembekuan tanpa simper.verify penuh di Site record
            if (e.code === "42501") return new ApiFailure("SCOPE_DENIED");
            return mapSimperError(e);
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
    path: "/simpers/{id}/document-url",
    tags: tag,
    summary: "URL dokumen SIMPER bertanda tangan berumur pendek (teraudit)",
    security,
    middleware: guardSelf(deps, "simper.read"),
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
        `select s.site_id, f.bucket, f.object_path, f.original_name, f.scan_status
           from simper s left join file_object f on f.id = s.file_id where s.id = $1`,
        [id],
      );
      const row = res.rows[0];
      if (!row?.bucket || !row.object_path) throw new ApiFailure("NOT_FOUND");
      if (row.scan_status !== "CLEAN") throw new ApiFailure("FILE_NOT_CLEAN");
      const ttl = 300;
      await tx.query(
        "select app.audit_record('simper.document_access', 'simper', $1, null, null, 'simper.read', $2, 'SUCCESS', false)",
        [id, row.site_id],
      );
      try {
        return {
          url: await storage.createDownloadUrl(row.bucket, row.object_path, ttl, safeFileName(row.original_name ?? "simper")),
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
  // ---------------------------------------------------------------- otorisasi per kelas alat (API-007 §4)
  const loadClassAuth = async (tx: Tx, id: string): Promise<Row> => {
    const r = await tx.query(`${CLASS_AUTH_SELECT} where a.id = $1`, [id]);
    if (!r.rows[0]) throw new ApiFailure("NOT_FOUND");
    return r.rows[0] as Row;
  };
  const listAuth = createRoute({
    method: "get",
    path: "/simpers/{id}/authorizations",
    tags: tag,
    summary: "Otorisasi kelas alat pada SIMPER",
    security,
    middleware: guardSelf(deps, "simper.read"),
    request: { params: IdParam },
    responses: { 200: json(list(ClassAuth), "Otorisasi kelas alat"), ...baseErrors, 404: json(ErrorResponse, "NOT_FOUND") },
  });
  v1.openapi(listAuth, async (c) => {
    const { id } = c.req.valid("param");
    const r = await run(c, deps, async (tx) => {
      if (!(await tx.query("select 1 from simper where id = $1", [id])).rows[0]) throw new ApiFailure("NOT_FOUND");
      return (await tx.query(`${CLASS_AUTH_SELECT} where a.simper_id = $1 order by a.status, a.valid_from`, [id])).rows as Row[];
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return c.json(
      {
        success: true,
        data: r.map(serialize),
        pagination: { limit: r.length, next_cursor: null, has_more: false },
        request_id: c.get("requestId"),
      },
      200,
    );
  });

  const addAuth = createRoute({
    method: "post",
    path: "/simpers/{id}/authorizations",
    tags: tag,
    summary: "Menambah otorisasi kelas alat (SIMPER terverifikasi kembali PENDING)",
    security,
    middleware: guardSelf(deps, "simper.update"),
    request: { params: IdParam, body: { content: { "application/json": { schema: ClassAuthInput } }, required: true } },
    responses: { 201: json(ok(ClassAuth), "Ditambahkan"), ...errs },
  });
  v1.openapi(addAuth, async (c) => {
    const { id } = c.req.valid("param");
    const identity = c.get("identity");
    const orgId = identity.organizationId;
    if (!orgId) return respondFailure(c, new ApiFailure("FORBIDDEN"));
    const r = await run(
      c,
      deps,
      async (tx) => {
        if (!(await tx.query("select 1 from simper where id = $1", [id])).rows[0]) throw new ApiFailure("NOT_FOUND");
        return loadClassAuth(tx, await insertClassAuth(tx, orgId, id, identity.userId, c.req.valid("json")));
      },
      { map: mapSimperError },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return respondOne(c, r, 201);
  });

  const patchAuth = createRoute({
    method: "patch",
    path: "/simper-authorizations/{id}",
    tags: tag,
    summary: "Mengubah otorisasi kelas alat (masa berlaku, pembatasan)",
    security,
    middleware: guardSelf(deps, "simper.update"),
    request: {
      params: IdParam,
      headers: IfMatch,
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                valid_from: IsoDate.optional(),
                valid_until: IsoDate.nullable().optional(),
                restriction_note: z.string().trim().max(500).nullable().optional(),
              })
              .openapi("SimperAuthorizationPatch"),
          },
        },
        required: true,
      },
    },
    responses: { 200: json(ok(ClassAuth), "Diubah"), ...errs },
  });
  v1.openapi(patchAuth, async (c) => {
    const { id } = c.req.valid("param");
    const expected = parseIfMatch(c.req.valid("header")["if-match"]);
    const b = c.req.valid("json") as Row;
    const r = await run(
      c,
      deps,
      async (tx) => {
        const cur = await tx.query<{ version: number; valid_from: string; valid_until: string | null }>(
          "select version, valid_from::text as valid_from, valid_until::text as valid_until from simper_authorization where id = $1",
          [id],
        );
        const row = cur.rows[0];
        if (!row) throw new ApiFailure("NOT_FOUND");
        if (expected !== row.version) throw new ApiFailure("VERSION_CONFLICT", undefined, { current_version: row.version });
        const from = (b.valid_from as string | undefined) ?? row.valid_from;
        const until = b.valid_until === undefined ? row.valid_until : (b.valid_until as string | null);
        if (until && until < from) throw new ApiFailure("INVALID_DATE_RANGE", [{ field: "valid_until", issue: "before_start" }]);
        const keys = ["valid_from", "valid_until", "restriction_note"].filter((k) => b[k] !== undefined);
        if (keys.length) {
          const res = await tx.query(
            `update simper_authorization set ${keys.map((k, i) => `${k} = $${i + 3}`).join(", ")} where id = $1 and version = $2`,
            [id, row.version, ...keys.map((k) => (b[k] === "" ? null : b[k]))],
          );
          if (res.rowCount === 0) throw new ApiFailure("SCOPE_DENIED");
        }
        return loadClassAuth(tx, id);
      },
      { map: mapSimperError },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return respondOne(c, r);
  });

  for (const action of ["suspend", "revoke", "reinstate"] as const) {
    const route = createRoute({
      method: "post",
      path: `/simper-authorizations/{id}/${action}`,
      tags: tag,
      summary:
        action === "suspend"
          ? "Membekukan otorisasi kelas alat (HSE Manager, alasan wajib)"
          : action === "revoke"
            ? "Mencabut otorisasi kelas alat, bersifat akhir (HSE Manager, alasan wajib)"
            : "Memulihkan otorisasi kelas alat yang dibekukan (HSE Manager, alasan wajib)",
      security,
      middleware: guard(deps, "simper.verify"),
      request: {
        params: IdParam,
        headers: IfMatch,
        body: {
          content: {
            "application/json": {
              schema: z.object({ reason: z.string().trim().max(500).optional() }).openapi("SimperAuthorizationAction"),
            },
          },
          required: true,
        },
      },
      responses: { 200: json(ok(ClassAuth), "Hasil"), ...errs, 403: json(ErrorResponse, "FORBIDDEN, SCOPE_DENIED") },
    });
    v1.openapi(route, async (c) => {
      const { id } = c.req.valid("param");
      const expected = parseIfMatch(c.req.valid("header")["if-match"]);
      const reason = c.req.valid("json").reason?.trim();
      if (!reason) return respondFailure(c, new ApiFailure("REASON_REQUIRED", [{ field: "reason", issue: "required" }]));
      const me = c.get("identity").userId;
      const r = await run(
        c,
        deps,
        async (tx) => {
          const cur = await tx.query<{ version: number; status: string }>(
            "select version, status from simper_authorization where id = $1",
            [id],
          );
          const row = cur.rows[0];
          if (!row) throw new ApiFailure("NOT_FOUND");
          if (expected !== row.version) throw new ApiFailure("VERSION_CONFLICT", undefined, { current_version: row.version });
          const from = action === "reinstate" ? ["SUSPENDED"] : action === "suspend" ? ["ACTIVE"] : ["ACTIVE", "SUSPENDED"];
          if (!from.includes(row.status)) throw new ApiFailure("INVALID_STATE_TRANSITION", [{ issue: row.status }]);
          const target = action === "suspend" ? "SUSPENDED" : action === "revoke" ? "REVOKED" : "ACTIVE";
          const res = await tx.query(
            `update simper_authorization set status = $3, status_reason = $4, status_changed_by = $5, status_changed_at = now()
              where id = $1 and version = $2`,
            [id, row.version, target, reason, me],
          );
          if (res.rowCount === 0) throw new ApiFailure("SCOPE_DENIED");
          return loadClassAuth(tx, id);
        },
        { map: (e) => (e.code === "42501" ? new ApiFailure("SCOPE_DENIED") : mapSimperError(e)) },
      );
      if (r instanceof ApiFailure) return respondFailure(c, r);
      return respondOne(c, r);
    });
  }
}

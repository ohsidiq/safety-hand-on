import { createRoute, z } from "@hono/zod-openapi";
import {
  ApiFailure,
  baseErrors,
  type Deps,
  ErrorResponse,
  guard,
  guardScoped,
  json,
  list,
  ok,
  type Row,
  respondFailure,
  run,
  security,
  serialize,
  type V1,
} from "./route-kit.js";

/**
 * Pemeriksaan kesiapan kerja khusus / pra-tugas (B-27, SRS-WF004 v1.4 FR-WF004-017..021, API-005 v2.1 bagian 5a).
 * - Hanya Dokter (`medical.clearance`) di Site pekerja. Checklist wajib: riwayat penyakit ditinjau, tensi diukur, tanda vital
 *   diukur, dalam batas aman. ANGKA TANDA VITAL TIDAK DITERIMA DAN TIDAK DISIMPAN (tetap di rekam medis klinik).
 * - SIAP berlaku satu shift: masa berlaku jenis kerja (bawaan 12 jam, maksimum 24). Ditolak bila MCU terakhir tidak berlaku
 *   atau UNFIT (422 MCU_NOT_VALID) atau ada pembatasan aktif yang menghalangi jenis kerja (422 RESTRICTION_CONFLICT).
 * - TIDAK SIAP wajib catatan berupa batasan kerja/tindak lanjut, bukan diagnosis.
 * - Hasil tidak dapat diubah; Dokter dapat mencabut dengan alasan (mis. keluhan baru), lalu memeriksa ulang.
 * - Tingkat status (`medical.read_status` sesuai scope): jenis, hasil, berlaku sampai. Tanpa checklist dan catatan.
 */

const Clearance = z
  .object({
    id: z.uuid(),
    clearance_type_id: z.uuid(),
    type_name: z.string(),
    type_code: z.string(),
    result: z.enum(["CLEARED", "NOT_CLEARED"]),
    examined_at: z.string(),
    valid_until: z.string().nullable(),
    active: z.boolean().openapi({ description: "SIAP, belum dicabut, belum lewat masa berlaku" }),
  })
  .openapi("MedicalClearance");

const STATUS_SELECT = `select id, clearance_type_id, type_name, type_code, result, examined_at, valid_until, active
  from app.medical_clearance_status($1)`;

const WorkerParam = z.object({ worker_id: z.uuid() });
const IdParam = z.object({ id: z.uuid() });

function mapClearanceError(e: { code?: string; message?: string; constraint?: string }): ApiFailure | undefined {
  const msg = e.message ?? "";
  if (e.code === "23514") {
    if (msg.startsWith("MCU_NOT_VALID")) return new ApiFailure("MCU_NOT_VALID");
    if (msg.startsWith("RESTRICTION_CONFLICT")) return new ApiFailure("RESTRICTION_CONFLICT");
    if (msg.startsWith("INVALID_STATE_TRANSITION")) return new ApiFailure("INVALID_STATE_TRANSITION");
    if (e.constraint === "medical_clearance_cleared_chk") return new ApiFailure("CHECKLIST_INCOMPLETE");
    if (e.constraint === "medical_clearance_not_cleared_chk" || e.constraint === "medical_clearance_revoke_chk")
      return new ApiFailure("REASON_REQUIRED", [{ field: "note", issue: "required" }]);
  }
  if (e.code === "42501") return new ApiFailure("SCOPE_DENIED");
  if (e.code === "23503") return new ApiFailure("VALIDATION_ERROR", [{ issue: "reference_not_found" }]);
  return undefined;
}

export function registerMedicalClearance(v1: V1, deps: Deps) {
  const tag = ["Medical"];
  const errs = {
    ...baseErrors,
    404: json(ErrorResponse, "NOT_FOUND (tidak ada atau di luar scope)"),
    409: json(ErrorResponse, "INVALID_STATE_TRANSITION"),
    422: json(ErrorResponse, "VALIDATION_ERROR, CHECKLIST_INCOMPLETE, MCU_NOT_VALID, RESTRICTION_CONFLICT, REASON_REQUIRED"),
  };

  const listRoute = createRoute({
    method: "get",
    path: "/workers/{worker_id}/medical-clearances",
    tags: tag,
    summary: "Pemeriksaan kesiapan kerja khusus 7 hari terakhir (tingkat status, tanpa checklist)",
    security,
    middleware: guardScoped(deps, "medical.read_status"),
    request: { params: WorkerParam },
    responses: { 200: json(list(Clearance), "Kesiapan"), ...baseErrors },
  });
  v1.openapi(listRoute, async (c) => {
    const { worker_id } = c.req.valid("param");
    const r = await run(c, deps, async (tx) => (await tx.query(STATUS_SELECT, [worker_id])).rows as Row[]);
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("Cache-Control", "no-store");
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

  const issue = createRoute({
    method: "post",
    path: "/workers/{worker_id}/medical-clearances",
    tags: tag,
    summary: "Menerbitkan pemeriksaan kesiapan kerja khusus (Dokter; checklist, tanpa angka tanda vital)",
    security,
    middleware: guard(deps, "medical.clearance"),
    request: {
      params: WorkerParam,
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                clearance_type_id: z.uuid(),
                result: z.enum(["CLEARED", "NOT_CLEARED"]),
                history_reviewed: z.boolean(),
                blood_pressure_checked: z.boolean(),
                vital_signs_checked: z.boolean(),
                vitals_within_limits: z.boolean(),
                note: z
                  .string()
                  .trim()
                  .max(300)
                  .optional()
                  .openapi({ description: "Wajib untuk NOT_CLEARED: batasan kerja/tindak lanjut, bukan diagnosis" }),
              })
              .strict()
              .openapi("MedicalClearanceCreate"),
          },
        },
        required: true,
      },
    },
    responses: { 201: json(ok(Clearance), "Diterbitkan"), ...errs },
  });
  v1.openapi(issue, async (c) => {
    const { worker_id } = c.req.valid("param");
    const b = c.req.valid("json");
    const identity = c.get("identity");
    if (!identity.organizationId) return respondFailure(c, new ApiFailure("FORBIDDEN"));
    if (b.result === "CLEARED") {
      const missing = (
        ["history_reviewed", "blood_pressure_checked", "vital_signs_checked", "vitals_within_limits"] as const
      ).filter((k) => !b[k]);
      if (missing.length)
        return respondFailure(
          c,
          new ApiFailure(
            "CHECKLIST_INCOMPLETE",
            missing.map((field) => ({ field, issue: "required_true" })),
          ),
        );
    } else if (!b.note) return respondFailure(c, new ApiFailure("REASON_REQUIRED", [{ field: "note", issue: "required" }]));
    const r = await run(
      c,
      deps,
      async (tx) => {
        const w = await tx.query<{ site_id: string }>("select site_id from worker where id = $1", [worker_id]);
        const site = w.rows[0]?.site_id;
        if (!site) throw new ApiFailure("NOT_FOUND");
        const t = await tx.query<{ status: string; validity_hours: number }>(
          "select status, validity_hours from medical_clearance_type where id = $1",
          [b.clearance_type_id],
        );
        const type = t.rows[0];
        if (type?.status !== "ACTIVE")
          throw new ApiFailure("VALIDATION_ERROR", [{ field: "clearance_type_id", issue: type ? "inactive" : "not_found" }]);
        const ins = await tx.query<{ id: string }>(
          `insert into medical_clearance (organization_id, site_id, worker_id, clearance_type_id, result, history_reviewed,
             blood_pressure_checked, vital_signs_checked, vitals_within_limits, note, examined_by, valid_until)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                   case when $5 = 'CLEARED' then now() + make_interval(hours => $12) end) returning id`,
          [
            identity.organizationId,
            site,
            worker_id,
            b.clearance_type_id,
            b.result,
            b.history_reviewed,
            b.blood_pressure_checked,
            b.vital_signs_checked,
            b.vitals_within_limits,
            b.note || null,
            identity.userId,
            type.validity_hours,
          ],
        );
        const row = (await tx.query(`${STATUS_SELECT} where id = $2`, [worker_id, ins.rows[0]?.id])).rows[0];
        if (!row) throw new ApiFailure("NOT_FOUND");
        return row as Row;
      },
      { map: mapClearanceError },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, data: serialize(r), request_id: c.get("requestId") }, 201);
  });

  const revoke = createRoute({
    method: "post",
    path: "/medical-clearances/{id}/revoke",
    tags: tag,
    summary: "Mencabut pemeriksaan kesiapan (Dokter, alasan wajib)",
    security,
    middleware: guard(deps, "medical.clearance"),
    request: {
      params: IdParam,
      body: {
        content: {
          "application/json": {
            schema: z.object({ reason: z.string().trim().max(300).optional() }).openapi("MedicalClearanceRevoke"),
          },
        },
        required: true,
      },
    },
    responses: { 200: json(ok(z.object({ id: z.uuid(), revoked: z.literal(true) })), "Dicabut"), ...errs },
  });
  v1.openapi(revoke, async (c) => {
    const { id } = c.req.valid("param");
    const reason = c.req.valid("json").reason?.trim();
    if (!reason) return respondFailure(c, new ApiFailure("REASON_REQUIRED", [{ field: "reason", issue: "required" }]));
    const r = await run(
      c,
      deps,
      async (tx) => {
        const cur = await tx.query<{ revoked_at: string | null }>("select revoked_at from medical_clearance where id = $1", [id]);
        if (!cur.rows[0]) throw new ApiFailure("NOT_FOUND");
        if (cur.rows[0].revoked_at) throw new ApiFailure("INVALID_STATE_TRANSITION");
        const res = await tx.query(
          "update medical_clearance set revoked_at = now(), revoked_by = $2, revoke_reason = $3 where id = $1",
          [id, c.get("identity").userId, reason],
        );
        if (res.rowCount === 0) throw new ApiFailure("SCOPE_DENIED");
        return { id, revoked: true as const };
      },
      { map: mapClearanceError },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return c.json({ success: true, data: r, request_id: c.get("requestId") }, 200);
  });
}

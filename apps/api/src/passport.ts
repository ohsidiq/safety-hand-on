import { createRoute, z } from "@hono/zod-openapi";
import {
  ApiFailure,
  baseErrors,
  type Deps,
  ErrorResponse,
  guard,
  guardScoped,
  json,
  ok,
  respondFailure,
  run,
  security,
  serialize,
  type V1,
} from "./route-kit.js";

/**
 * QR Safety Passport (API-014 bagian 7, FR-RE-013, RDY-API-006/007, migrasi 0024). M4.3.
 * - QR berisi token acak berumur 5 menit, bukan SHO ID; hanya hash token yang disimpan di database.
 * - Pemindai harus terautentikasi dengan readiness.read atas pekerja itu (organisasi, Site, atau tim); pemindaian
 *   tercatat di audit (`passport.scan`). Respons minimal tanpa detail medis, NIK, atau nomor dokumen.
 * - Foto pekerja belum ada (unggah foto belum dibangun): `photo_url` selalu null.
 */

export const PASSPORT_REFRESH_SECONDS = 240;

const Token = z
  .object({
    token: z.string(),
    expires_at: z.string(),
    refresh_after_seconds: z.number(),
  })
  .openapi("PassportToken");

const Category = z.object({
  item_type: z.enum(["COMPETENCY", "MEDICAL", "AUTHORIZATION", "SIMPER"]),
  ok: z.boolean(),
  warning: z.enum(["EXPIRING_SOON", "RESTRICTED"]).nullable(),
  unmet: z.number().openapi({ description: "Jumlah syarat wajib yang belum terpenuhi" }),
  total: z.number(),
  unmet_names: z
    .array(z.string())
    .openapi({ description: "Nama syarat non-medis yang belum terpenuhi; selalu kosong untuk MEDICAL (SRS-RE 10)" }),
});

const Verified = z
  .object({
    worker_id: z.uuid(),
    full_name: z.string(),
    photo_url: z.string().nullable(),
    job_position: z.string().nullable(),
    site: z.string().nullable(),
    status: z.enum(["READY", "CONDITIONAL", "NOT_READY"]).nullable().openapi({ description: "null bila belum pernah dinilai" }),
    reason_code: z
      .enum(["WORKER_INACTIVE", "PROFILE_NOT_SET"])
      .nullable()
      .openapi({ description: "Alasan Tidak siap tanpa penilaian syarat (pekerja tidak aktif / jabatan tanpa daftar syarat)" }),
    categories: z.array(Category),
    evaluated_at: z.string().nullable(),
  })
  .openapi("PassportVerification");

function mapPassportError(e: { code?: string; message?: string }): ApiFailure | undefined {
  if (e.code === "P0002") return new ApiFailure("NOT_FOUND");
  if (e.code === "28000")
    return new ApiFailure(e.message === "PASSPORT_TOKEN_EXPIRED" ? "PASSPORT_TOKEN_EXPIRED" : "PASSPORT_TOKEN_INVALID");
  if (e.code === "23514" && e.message?.startsWith("WORKER_INACTIVE")) return new ApiFailure("WORKER_INACTIVE");
  return undefined;
}

export function registerPassport(v1: V1, deps: Deps) {
  const tag = ["Readiness"];

  const issue = createRoute({
    method: "post",
    path: "/workers/{worker_id}/passport/token",
    tags: tag,
    summary: "Menerbitkan token QR Safety Passport (5 menit) untuk pekerja sendiri atau pekerja dalam scope",
    security,
    middleware: guardScoped(deps, "readiness.read"),
    request: { params: z.object({ worker_id: z.uuid() }) },
    responses: {
      201: json(ok(Token), "Token diterbitkan"),
      ...baseErrors,
      404: json(ErrorResponse, "NOT_FOUND"),
      409: json(ErrorResponse, "WORKER_INACTIVE"),
    },
  });
  v1.openapi(issue, async (c) => {
    const { worker_id } = c.req.valid("param");
    const r = await run(
      c,
      deps,
      async (tx) => {
        const q = await tx.query<{ token: string; expires_at: Date }>("select token, expires_at from app.passport_issue($1)", [
          worker_id,
        ]);
        const row = q.rows[0];
        if (!row) throw new ApiFailure("NOT_FOUND");
        return {
          token: row.token,
          expires_at: new Date(row.expires_at).toISOString(),
          refresh_after_seconds: PASSPORT_REFRESH_SECONDS,
        };
      },
      { map: mapPassportError },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, data: r, request_id: c.get("requestId") }, 201);
  });

  const verify = createRoute({
    method: "get",
    path: "/passport/verify",
    tags: tag,
    summary: "Memverifikasi QR hasil pindai (pemindai terautentikasi, tercatat di audit)",
    security,
    middleware: guard(deps, "readiness.read"),
    request: { headers: z.object({ "x-passport-token": z.string().min(1).max(200) }) },
    responses: {
      200: json(ok(Verified), "Hasil verifikasi"),
      ...baseErrors,
      404: json(ErrorResponse, "NOT_FOUND (pekerja di luar scope pemindai)"),
    },
  });
  v1.openapi(verify, async (c) => {
    const token = c.req.valid("header")["x-passport-token"].trim();
    const r = await run(
      c,
      deps,
      async (tx) => {
        const q = await tx.query(
          "select worker_id, full_name, job_position, site, status, reason_code, categories, evaluated_at from app.passport_verify($1)",
          [token],
        );
        const row = q.rows[0];
        if (!row) throw new ApiFailure("NOT_FOUND");
        return { ...serialize(row), photo_url: null };
      },
      { map: mapPassportError },
    );
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, data: r, request_id: c.get("requestId") }, 200);
  });
}

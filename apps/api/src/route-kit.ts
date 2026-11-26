import { type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db, Tx } from "@soh/db";
import { withUser } from "@soh/db";
import type { Context, MiddlewareHandler } from "hono";
import { type AuthEnv, type AuthVerifier, authenticate, requirePermission, requirePermissionOrSelf } from "./auth.js";
import { type ErrorCode, type ErrorDetail, errorBody, errorStatus } from "./errors.js";

/** Perlengkapan bersama rute domain (API-000 §7, §10): amplop respons, galat, If-Match, transaksi withUser. */

export type V1 = OpenAPIHono<AuthEnv>;
export type Deps = { auth?: AuthVerifier | undefined; db?: Db | undefined };
export type Ctx = Context<AuthEnv>;
export type Row = Record<string, unknown>;

// ---------------------------------------------------------------- skema bersama

export const ErrorResponse = z
  .object({
    success: z.literal(false),
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.array(z.object({ field: z.string().optional(), issue: z.string() })).optional(),
    }),
    request_id: z.string(),
  })
  .openapi("ApiErrorResponse");

export const json = (schema: z.ZodType, description: string) => ({ content: { "application/json": { schema } }, description });
export const ok = (data: z.ZodType) => z.object({ success: z.literal(true), data, request_id: z.string() });
export const list = (item: z.ZodType) =>
  z.object({
    success: z.literal(true),
    data: z.array(item),
    pagination: z.object({ limit: z.number(), next_cursor: z.string().nullable(), has_more: z.boolean() }),
    request_id: z.string(),
  });
export const security = [{ bearerAuth: [] }];
export const baseErrors = {
  401: json(ErrorResponse, "UNAUTHORIZED atau TOKEN_EXPIRED"),
  403: json(ErrorResponse, "FORBIDDEN, SCOPE_DENIED atau ACCOUNT_DEACTIVATED"),
};
export const writeErrors = {
  ...baseErrors,
  404: json(ErrorResponse, "NOT_FOUND (tidak ada atau di luar organisasi/scope)"),
  409: json(ErrorResponse, "DUPLICATE (kode sudah dipakai) atau CONFLICT (masih dipakai pekerja aktif)"),
  422: json(ErrorResponse, "VALIDATION_ERROR"),
};
export const IF_MATCH_RE = /^(?:W\/)?"?\d{1,9}"?$/;
export const IfMatchValue = z
  .string()
  .regex(IF_MATCH_RE)
  .openapi({ description: "Versi terakhir yang dibaca (API-000 §10). Tidak ada/rusak -> 422", example: '"3"' });
export const IfMatch = z.object({ "if-match": IfMatchValue });
export const LIST_LIMIT = 500;

export class ApiFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly details?: ErrorDetail[],
    readonly extra?: Row,
  ) {
    super(code);
  }
}

export function serialize(row: Row): Row {
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
export function respondFailure(c: Ctx, f: ApiFailure): never {
  const body = errorBody(f.code, c.get("requestId"), f.details);
  return c.json(f.extra ? { ...body, error: { ...body.error, ...f.extra } } : body, errorStatus[f.code]) as never;
}

export interface RunOptions {
  /** Isu galat saat struktur masih dipakai pekerja aktif. */
  inUseIssue?: string;
  /** Pemetaan galat khusus domain; undefined = pakai pemetaan umum. */
  map?: (err: { code?: string; message?: string; constraint?: string }) => ApiFailure | undefined;
  /** Variabel transaksi tambahan (GUC app.*) sebelum fn, mis. app.change_reason. */
  settings?: Record<string, string>;
}

export async function run<T>(c: Ctx, deps: Deps, fn: (tx: Tx) => Promise<T>, opts: RunOptions = {}): Promise<T | ApiFailure> {
  const identity = c.get("identity");
  try {
    return await withUser(
      deps.db as Db,
      identity.userId,
      async (tx) => {
        for (const [k, v] of Object.entries(opts.settings ?? {})) {
          await tx.query("select set_config($1, $2, true)", [`app.${k}`, v]);
        }
        return fn(tx);
      },
      identity.ctx,
    );
  } catch (err) {
    if (!(err instanceof ApiFailure) && opts.map) {
      const mapped = opts.map(err as { code?: string; message?: string; constraint?: string });
      if (mapped) return mapped;
    }
    return mapPgError(err, opts.inUseIssue);
  }
}

export const guard = (deps: Deps, permission: string): MiddlewareHandler<AuthEnv>[] => [
  authenticate(deps),
  requirePermission(permission),
];

/** Guard yang juga menerima permission tingkat SELF (mis. WORKER competency.update SELF). */
export const guardSelf = (deps: Deps, permission: string): MiddlewareHandler<AuthEnv>[] => [
  authenticate(deps),
  requirePermissionOrSelf(permission),
];

/**
 * Guard untuk permission yang aturan LIMITED/SELF-nya sudah dibangun di RLS (Medical): FULL/TEAM, LIMITED, atau SELF.
 * Batas sebenarnya (record mana) ditegakkan RLS dan pemicu.
 */
export const guardScoped = (deps: Deps, permission: string): MiddlewareHandler<AuthEnv>[] => [
  authenticate(deps),
  async (c, next) => {
    const id = c.get("identity");
    const ok = id?.permissions.has(permission) || id?.limitedPermissions?.has(permission) || id?.selfPermissions?.has(permission);
    if (!ok) return c.json(errorBody("FORBIDDEN", c.get("requestId")), 403);
    await next();
  },
];

/** Lolos bila salah satu permission ada (FULL/TEAM), atau permission tingkat SELF pada selfAlso. */
export const guardAny = (deps: Deps, permissions: string[], selfAlso: string[] = []): MiddlewareHandler<AuthEnv>[] => [
  authenticate(deps),
  async (c, next) => {
    const id = c.get("identity");
    const okFull = permissions.some((p) => id?.permissions.has(p));
    const okSelf = selfAlso.some((p) => id?.selfPermissions?.has(p));
    if (!okFull && !okSelf) return c.json(errorBody("FORBIDDEN", c.get("requestId")), 403);
    await next();
  },
];

/** Memperbarui satu baris dengan pemeriksaan keberadaan (404), versi (412), dan scope tulis (403). */
export async function updateRow(
  tx: Tx,
  table: string,
  columns: string,
  id: string,
  set: Row,
  expected: number | null,
): Promise<Row> {
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
  const assigns = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
  // version ikut dicocokkan saat update: penulis lain di antara baca dan tulis -> 0 baris -> diperiksa ulang
  const res = await tx.query(`update ${table} set ${assigns} where id = $1 and version = $2 returning ${columns}`, [
    id,
    row.version,
    ...keys.map((k) => set[k]),
  ]);
  if (res.rowCount === 0) {
    const again = await tx.query<{ version: number }>(`select version from ${table} where id = $1`, [id]);
    const v = again.rows[0]?.version;
    if (v !== undefined && v !== row.version) throw new ApiFailure("VERSION_CONFLICT", undefined, { current_version: v });
  }
  // terlihat (baca) tetapi kebijakan tulis menolak: permission ada, di luar scope tulis
  if (res.rowCount === 0) throw new ApiFailure("SCOPE_DENIED");
  return res.rows[0] as Row;
}

export function pick(body: Row, keys: string[]): Row {
  const out: Row = {};
  for (const k of keys) if (body[k] !== undefined) out[k] = body[k];
  return out;
}

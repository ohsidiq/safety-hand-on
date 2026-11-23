import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db, Tx } from "@soh/db";
import { withUser } from "@soh/db";
import { type AuthEnv, type AuthVerifier, authenticate, requirePermission } from "./auth.js";
import { errorBody } from "./errors.js";

/**
 * Membaca Audit Trail (API-016 §2). Tidak ada endpoint tulis/ubah/hapus (AUD-API-001).
 * Isolasi organisasi dan audit.view ditegakkan dua lapis: requirePermission di API dan RLS di database.
 * Setiap pembacaan audit dicatat sebagai `audit.read` (AUD-API-005, BR-PLT03-005).
 */

const MAX_RANGE_MS = 92 * 24 * 60 * 60 * 1000;
const ACTION_RE = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;

const ErrorResponse = z
  .object({ success: z.literal(false), error: z.object({ code: z.string(), message: z.string() }), request_id: z.string() })
  .openapi("AuditErrorResponse");

const AuditEvent = z
  .object({
    id: z.uuid(),
    occurred_at: z.string(),
    actor_kind: z.enum(["USER", "SYSTEM", "SUPPORT"]),
    actor: z
      .object({
        user_id: z.uuid(),
        full_name: z.string().nullable(),
        role_code: z.string().nullable(),
        scope_type: z.string().nullable(),
      })
      .nullable(),
    action: z.string().openapi({ example: "access.role_assigned" }),
    entity_type: z.string(),
    entity_id: z.uuid().nullable(),
    site_id: z.uuid().nullable(),
    changed_fields: z.array(z.string()).nullable(),
    changes: z.record(z.string(), z.unknown()).nullable(),
    sensitive_access: z.boolean(),
    access_reason: z.string().nullable(),
    result: z.enum(["SUCCESS", "DENIED", "FAILED"]),
    request_id: z.string().nullable(),
    ip: z.string().nullable().optional().openapi({ description: "Hanya untuk Company Admin dan Auditor" }),
    user_agent: z.string().nullable().optional().openapi({ description: "Hanya untuk Company Admin dan Auditor" }),
  })
  .openapi("AuditEvent");

const ListQuery = z.object({
  from: z.string().optional().openapi({ description: "Awal rentang (ISO 8601, UTC). Wajib", example: "2026-11-01T00:00:00Z" }),
  to: z.string().optional().openapi({ description: "Akhir rentang (ISO 8601, UTC). Wajib, maksimum 92 hari" }),
  actor_user_id: z.uuid().optional(),
  action: z.string().max(500).optional().openapi({ description: "Satu atau beberapa kode aksi, dipisah koma" }),
  entity_type: z
    .string()
    .regex(/^[a-z_]{1,64}$/)
    .optional(),
  entity_id: z.uuid().optional(),
  site_id: z.uuid().optional(),
  result: z.enum(["SUCCESS", "DENIED", "FAILED"]).optional(),
  sensitive_access: z.enum(["true", "false"]).optional(),
  actor_kind: z.enum(["USER", "SYSTEM", "SUPPORT"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(200).optional(),
});

const ListResponse = z
  .object({
    success: z.literal(true),
    data: z.array(AuditEvent),
    pagination: z.object({ limit: z.number(), next_cursor: z.string().nullable(), has_more: z.boolean() }),
    request_id: z.string(),
  })
  .openapi("AuditListResponse");

const json = (schema: z.ZodType, description: string) => ({ content: { "application/json": { schema } }, description });
const commonErrors = {
  401: json(ErrorResponse, "UNAUTHORIZED atau TOKEN_EXPIRED"),
  403: json(ErrorResponse, "FORBIDDEN (tanpa audit.view) atau ACCOUNT_DEACTIVATED"),
  422: json(ErrorResponse, "VALIDATION_ERROR"),
};

const listRoute = createRoute({
  method: "get",
  path: "/audit-logs",
  tags: ["Audit"],
  summary: "Daftar jejak audit organisasi (kursor, filter)",
  security: [{ bearerAuth: [] }],
  request: { query: ListQuery },
  responses: {
    200: json(ListResponse, "Daftar kejadian audit, terbaru lebih dulu"),
    400: json(ErrorResponse, "DATE_RANGE_REQUIRED atau DATE_RANGE_TOO_LARGE"),
    ...commonErrors,
  },
});

const detailRoute = createRoute({
  method: "get",
  path: "/audit-logs/{id}",
  tags: ["Audit"],
  summary: "Detail satu kejadian audit",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: json(z.object({ success: z.literal(true), data: AuditEvent, request_id: z.string() }), "Kejadian audit"),
    404: json(ErrorResponse, "NOT_FOUND (tidak ada atau milik organisasi lain)"),
    ...commonErrors,
  },
});

type Row = {
  id: string;
  occurred_at: Date;
  actor_kind: "USER" | "SYSTEM" | "SUPPORT";
  actor_user_id: string | null;
  actor_full_name: string | null;
  actor_role_code: string | null;
  actor_scope_type: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  site_id: string | null;
  changed_fields: string[] | null;
  changes: Record<string, unknown> | null;
  sensitive_access: boolean;
  access_reason: string | null;
  result: "SUCCESS" | "DENIED" | "FAILED";
  request_id: string | null;
  ip: string | null;
  user_agent: string | null;
};

const SELECT = `
  select a.id, a.occurred_at, a.actor_kind, a.actor_user_id, up.full_name as actor_full_name, a.actor_role_code,
         a.actor_scope_type, a.action, a.entity_type, a.entity_id, a.site_id, a.changed_fields, a.changes,
         a.sensitive_access, a.access_reason, a.result, a.request_id, host(a.ip) as ip, a.user_agent
  from audit_log a left join user_profile up on up.id = a.actor_user_id`;

function toEvent(r: Row, withNetwork: boolean): z.infer<typeof AuditEvent> {
  return {
    id: r.id,
    occurred_at: r.occurred_at.toISOString(),
    actor_kind: r.actor_kind,
    actor: r.actor_user_id
      ? { user_id: r.actor_user_id, full_name: r.actor_full_name, role_code: r.actor_role_code, scope_type: r.actor_scope_type }
      : null,
    action: r.action,
    entity_type: r.entity_type,
    entity_id: r.entity_id,
    site_id: r.site_id,
    changed_fields: r.changed_fields,
    changes: r.changes,
    sensitive_access: r.sensitive_access,
    access_reason: r.access_reason,
    result: r.result,
    request_id: r.request_id,
    ...(withNetwork ? { ip: r.ip, user_agent: r.user_agent } : {}),
  };
}

/** ip dan user_agent hanya untuk Company Admin dan Auditor (API-016 §2). */
async function canSeeNetwork(tx: Tx, userId: string): Promise<boolean> {
  const r = await tx.query(
    `select 1 from user_role_assignment where user_id = $1 and role_code in ('COMPANY_ADMIN', 'AUDITOR')
       and revoked_at is null and valid_from <= now() and (valid_until is null or valid_until > now()) limit 1`,
    [userId],
  );
  return (r.rowCount ?? 0) > 0;
}

function encodeCursor(r: Row): string {
  return Buffer.from(JSON.stringify({ t: r.occurred_at.toISOString(), id: r.id })).toString("base64url");
}

function decodeCursor(cursor: string): { t: string; id: string } | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { t?: unknown; id?: unknown };
    if (typeof v.t !== "string" || Number.isNaN(Date.parse(v.t))) return null;
    if (typeof v.id !== "string" || !z.uuid().safeParse(v.id).success) return null;
    return { t: v.t, id: v.id };
  } catch {
    return null;
  }
}

export function registerAuditLogs(v1: OpenAPIHono<AuthEnv>, deps: { auth?: AuthVerifier | undefined; db?: Db | undefined }) {
  const guard = [authenticate(deps), requirePermission("audit.view")] as const;
  v1.use("/audit-logs", ...guard);
  v1.use("/audit-logs/*", ...guard);

  v1.openapi(listRoute, async (c) => {
    const q = c.req.valid("query");
    const rid = c.get("requestId");
    if (!q.from || !q.to) return c.json(errorBody("DATE_RANGE_REQUIRED", rid), 400);
    const from = Date.parse(q.from);
    const to = Date.parse(q.to);
    if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return c.json(errorBody("VALIDATION_ERROR", rid), 422);
    if (to - from > MAX_RANGE_MS) return c.json(errorBody("DATE_RANGE_TOO_LARGE", rid), 400);
    const actions = q.action
      ? q.action
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean)
      : undefined;
    if (actions && (actions.length > 20 || !actions.every((a) => ACTION_RE.test(a)))) {
      return c.json(errorBody("VALIDATION_ERROR", rid), 422);
    }
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    if (q.cursor && !cursor) return c.json(errorBody("VALIDATION_ERROR", rid), 422);
    const limit = q.limit ?? 50;

    const where: string[] = ["a.occurred_at >= $1", "a.occurred_at < $2"];
    const params: unknown[] = [new Date(from).toISOString(), new Date(to).toISOString()];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (q.actor_user_id) add("a.actor_user_id = ?", q.actor_user_id);
    if (actions) add("a.action = any(?::text[])", actions);
    if (q.entity_type) add("a.entity_type = ?", q.entity_type);
    if (q.entity_id) add("a.entity_id = ?", q.entity_id);
    if (q.site_id) add("a.site_id = ?", q.site_id);
    if (q.result) add("a.result = ?", q.result);
    if (q.sensitive_access) add("a.sensitive_access = ?", q.sensitive_access === "true");
    if (q.actor_kind) add("a.actor_kind = ?", q.actor_kind);
    if (cursor) {
      params.push(cursor.t, cursor.id);
      where.push(`(a.occurred_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(limit + 1);

    const identity = c.get("identity");
    const filters = Object.fromEntries(
      Object.entries({ ...q, cursor: undefined }).filter(([, v]) => v !== undefined && v !== ""),
    );
    const out = await withUser(
      deps.db as Db,
      identity.userId,
      async (tx) => {
        const rows = await tx.query<Row>(
          `${SELECT} where ${where.join(" and ")} order by a.occurred_at desc, a.id desc limit $${params.length}`,
          params,
        );
        const network = await canSeeNetwork(tx, identity.userId);
        await tx.query("select app.audit_record('audit.read', 'audit_log', null, $1::text[], $2::jsonb, 'audit.view')", [
          Object.keys(filters),
          JSON.stringify({ filters }),
        ]);
        return { rows: rows.rows, network };
      },
      identity.ctx,
    );
    const hasMore = out.rows.length > limit;
    const page = out.rows.slice(0, limit);
    const last = page[page.length - 1];
    return c.json(
      {
        success: true as const,
        data: page.map((r) => toEvent(r, out.network)),
        pagination: { limit, next_cursor: hasMore && last ? encodeCursor(last) : null, has_more: hasMore },
        request_id: rid,
      },
      200,
    );
  });

  v1.openapi(detailRoute, async (c) => {
    const { id } = c.req.valid("param");
    const identity = c.get("identity");
    const out = await withUser(
      deps.db as Db,
      identity.userId,
      async (tx) => {
        const rows = await tx.query<Row>(`${SELECT} where a.id = $1 limit 1`, [id]);
        if (!rows.rows[0]) return null;
        const network = await canSeeNetwork(tx, identity.userId);
        await tx.query("select app.audit_record('audit.read', 'audit_log', $1, null, null, 'audit.view')", [id]);
        return toEvent(rows.rows[0], network);
      },
      identity.ctx,
    );
    // Di luar organisasi pemanggil dijawab sama dengan tidak ada (API-016 §7)
    if (!out) return c.json(errorBody("NOT_FOUND", c.get("requestId")), 404);
    return c.json({ success: true as const, data: out, request_id: c.get("requestId") }, 200);
  });
}

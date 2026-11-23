import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "@soh/db";
import { withUser } from "@soh/db";
import { type AuthEnv, type AuthVerifier, authenticate, requirePermission } from "./auth.js";
import { errorBody } from "./errors.js";

/**
 * Kotak masuk notifikasi (API-015 §2). Hanya notifikasi milik pemanggil (NTF-API-002), ditegakkan RLS.
 * Tidak ada endpoint pembuatan notifikasi dari klien (NTF-API-001). Isi berasal dari template (NTF-API-003).
 */

const ErrorResponse = z
  .object({ success: z.literal(false), error: z.object({ code: z.string(), message: z.string() }), request_id: z.string() })
  .openapi("NotificationErrorResponse");

const Priority = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const Category = z.enum([
  "READINESS",
  "EXPIRY",
  "VERIFICATION",
  "INSPECTION",
  "OBSERVATION",
  "CORRECTIVE_ACTION",
  "TRAINING",
  "AI",
  "SYSTEM",
]);

const Notification = z
  .object({
    id: z.uuid(),
    notification_type: z.string().openapi({ example: "SYSTEM_ALERT" }),
    category: Category,
    priority: Priority,
    title: z.string(),
    body: z.string(),
    link: z.string().nullable(),
    entity: z.object({ type: z.string(), id: z.uuid() }).nullable(),
    created_at: z.string(),
    read_at: z.string().nullable(),
  })
  .openapi("Notification");

const json = (schema: z.ZodType, description: string) => ({ content: { "application/json": { schema } }, description });
const errors = {
  401: json(ErrorResponse, "UNAUTHORIZED atau TOKEN_EXPIRED"),
  403: json(ErrorResponse, "FORBIDDEN atau ACCOUNT_DEACTIVATED"),
};
const security = [{ bearerAuth: [] }];
const IdParam = z.object({ id: z.uuid() });
const Ok = z.object({ success: z.literal(true), data: z.object({ updated: z.number().int() }), request_id: z.string() });

const listRoute = createRoute({
  method: "get",
  path: "/notifications",
  tags: ["Notifications"],
  summary: "Kotak masuk (kursor), terbaru lebih dulu, tanpa yang diarsipkan",
  security,
  request: {
    query: z.object({
      unread_only: z.enum(["true", "false"]).optional(),
      type: z
        .string()
        .regex(/^[A-Z_]{3,64}$/)
        .optional(),
      priority: Priority.optional(),
      category: Category.optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      cursor: z.string().max(200).optional(),
    }),
  },
  responses: {
    200: json(
      z.object({
        success: z.literal(true),
        data: z.array(Notification),
        pagination: z.object({ limit: z.number(), next_cursor: z.string().nullable(), has_more: z.boolean() }),
        request_id: z.string(),
      }),
      "Daftar notifikasi",
    ),
    ...errors,
    422: json(ErrorResponse, "VALIDATION_ERROR"),
  },
});

const countRoute = createRoute({
  method: "get",
  path: "/notifications/unread-count",
  tags: ["Notifications"],
  summary: "Jumlah belum dibaca (untuk lencana)",
  security,
  responses: {
    200: json(
      z.object({ success: z.literal(true), data: z.object({ unread: z.number().int() }), request_id: z.string() }),
      "Jumlah",
    ),
    ...errors,
  },
});

const readAllRoute = createRoute({
  method: "post",
  path: "/notifications/read-all",
  tags: ["Notifications"],
  summary: "Tandai semua dibaca (opsional per kategori)",
  security,
  request: {
    body: { content: { "application/json": { schema: z.object({ category: Category.optional() }) } }, required: false },
  },
  responses: { 200: json(Ok, "Jumlah yang ditandai"), 422: json(ErrorResponse, "VALIDATION_ERROR"), ...errors },
});

const detailRoute = createRoute({
  method: "get",
  path: "/notifications/{id}",
  tags: ["Notifications"],
  summary: "Detail notifikasi milik sendiri",
  security,
  request: { params: IdParam },
  responses: {
    200: json(z.object({ success: z.literal(true), data: Notification, request_id: z.string() }), "Notifikasi"),
    404: json(ErrorResponse, "NOT_FOUND (bukan milik pemanggil atau tidak ada)"),
    ...errors,
  },
});

const markRoute = (action: "read" | "archive") =>
  createRoute({
    method: "post",
    path: `/notifications/{id}/${action}`,
    tags: ["Notifications"],
    summary: action === "read" ? "Tandai dibaca" : "Arsipkan",
    security,
    request: { params: IdParam },
    responses: { 200: json(Ok, "Berhasil"), 404: json(ErrorResponse, "NOT_FOUND"), ...errors },
  });

type Row = {
  id: string;
  notification_type: string;
  category: z.infer<typeof Category>;
  priority: z.infer<typeof Priority>;
  title: string;
  body: string;
  link: string | null;
  entity_type: string | null;
  entity_id: string | null;
  created_at: Date;
  read_at: Date | null;
};

const SELECT = `
  select n.id, n.notification_type, t.category, n.priority, n.title, n.body, n.link, n.entity_type, n.entity_id,
         n.created_at, n.read_at
  from notification n join notification_type t on t.code = n.notification_type`;

function toItem(r: Row): z.infer<typeof Notification> {
  return {
    id: r.id,
    notification_type: r.notification_type,
    category: r.category,
    priority: r.priority,
    title: r.title,
    body: r.body,
    link: r.link,
    entity: r.entity_type && r.entity_id ? { type: r.entity_type, id: r.entity_id } : null,
    created_at: r.created_at.toISOString(),
    read_at: r.read_at?.toISOString() ?? null,
  };
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

export function registerNotifications(v1: OpenAPIHono<AuthEnv>, deps: { auth?: AuthVerifier | undefined; db?: Db | undefined }) {
  const guard = [authenticate(deps), requirePermission("notification.read")] as const;
  v1.use("/notifications", ...guard);
  v1.use("/notifications/*", ...guard);
  const run = <T>(c: { get: (k: "identity") => AuthEnv["Variables"]["identity"] }, fn: Parameters<typeof withUser<T>>[2]) => {
    const identity = c.get("identity");
    return withUser(deps.db as Db, identity.userId, fn, identity.ctx);
  };

  v1.openapi(listRoute, async (c) => {
    const q = c.req.valid("query");
    const rid = c.get("requestId");
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    if (q.cursor && !cursor) return c.json(errorBody("VALIDATION_ERROR", rid), 422);
    const limit = q.limit ?? 50;
    const where = ["n.archived_at is null"];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (q.unread_only === "true") where.push("n.read_at is null");
    if (q.type) add("n.notification_type = ?", q.type);
    if (q.priority) add("n.priority = ?", q.priority);
    if (q.category) add("t.category = ?", q.category);
    if (cursor) {
      params.push(cursor.t, cursor.id);
      where.push(`(n.created_at, n.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(limit + 1);
    const rows = await run<Row[]>(c, async (tx) => {
      const r = await tx.query<Row>(
        `${SELECT} where ${where.join(" and ")} order by n.created_at desc, n.id desc limit $${params.length}`,
        params,
      );
      return r.rows;
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const next =
      hasMore && last
        ? Buffer.from(JSON.stringify({ t: last.created_at.toISOString(), id: last.id })).toString("base64url")
        : null;
    return c.json(
      {
        success: true as const,
        data: page.map(toItem),
        pagination: { limit, next_cursor: next, has_more: hasMore },
        request_id: rid,
      },
      200,
    );
  });

  v1.openapi(countRoute, async (c) => {
    const unread = await run<number>(c, async (tx) => {
      const r = await tx.query<{ n: number }>(
        "select count(*)::int as n from notification where read_at is null and archived_at is null",
      );
      return r.rows[0]?.n ?? 0;
    });
    return c.json({ success: true as const, data: { unread }, request_id: c.get("requestId") }, 200);
  });

  v1.openapi(readAllRoute, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { category?: unknown };
    const parsed = Category.optional().safeParse(body?.category);
    if (!parsed.success) return c.json(errorBody("VALIDATION_ERROR", c.get("requestId")), 422);
    const updated = await run<number>(c, async (tx) => {
      const r = await tx.query(
        `update notification n set read_at = now()
         where n.read_at is null and n.archived_at is null
           and ($1::text is null or exists (select 1 from notification_type t where t.code = n.notification_type and t.category = $1))`,
        [parsed.data ?? null],
      );
      return r.rowCount ?? 0;
    });
    return c.json({ success: true as const, data: { updated }, request_id: c.get("requestId") }, 200);
  });

  v1.openapi(detailRoute, async (c) => {
    const { id } = c.req.valid("param");
    const row = await run<Row | undefined>(c, async (tx) => (await tx.query<Row>(`${SELECT} where n.id = $1`, [id])).rows[0]);
    if (!row) return c.json(errorBody("NOT_FOUND", c.get("requestId")), 404);
    return c.json({ success: true as const, data: toItem(row), request_id: c.get("requestId") }, 200);
  });

  for (const action of ["read", "archive"] as const) {
    v1.openapi(markRoute(action), async (c) => {
      const { id } = c.req.valid("param");
      const column = action === "read" ? "read_at" : "archived_at";
      const updated = await run<number>(c, async (tx) => {
        // Idempoten: menandai ulang tidak mengubah waktu pertama; RLS membatasi ke milik sendiri
        const r = await tx.query(`update notification set ${column} = coalesce(${column}, now()) where id = $1`, [id]);
        return r.rowCount ?? 0;
      });
      if (updated === 0) return c.json(errorBody("NOT_FOUND", c.get("requestId")), 404);
      return c.json({ success: true as const, data: { updated }, request_id: c.get("requestId") }, 200);
    });
  }
}

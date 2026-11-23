import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "@soh/db";
import { withUser } from "@soh/db";
import { type AuthEnv, type AuthVerifier, authenticate, requirePermission } from "./auth.js";

/**
 * GET /api/v1/dashboard/summary (API-012 §3). "Isi mengikuti peran dan fase".
 * Fase P0: hanya blok `administration` (Dashboard Administrasi Platform untuk Company Admin, PB-020 §4),
 * diberikan bila pemanggil memiliki `user.manage`. Blok readiness/operasional menyusul di P1/P2.
 * P0 menghitung langsung dari tabel kecil (pengguna, pekerja) di bawah RLS; `as_of` = waktu hitung.
 */

const ErrorResponse = z
  .object({ success: z.literal(false), error: z.object({ code: z.string(), message: z.string() }), request_id: z.string() })
  .openapi("DashboardErrorResponse");

const Administration = z
  .object({
    users: z.object({
      active: z.number().int(),
      invited: z.number().int().openapi({ description: "Undangan tertunda (status INVITED)" }),
      locked: z.number().int(),
      deactivated: z.number().int(),
    }),
    workers: z.object({
      total: z.number().int(),
      with_account: z.number().int().openapi({ description: "Pekerja yang terhubung ke akun (B-18)" }),
      missing_job_position: z.number().int().openapi({ description: "Kelengkapan data: pekerja tanpa Job Position" }),
    }),
  })
  .openapi("DashboardAdministration");

const Summary = z
  .object({
    success: z.literal(true),
    data: z.object({
      as_of: z.string(),
      scope: z.object({ organization_id: z.uuid().nullable() }),
      administration: Administration.optional(),
    }),
    request_id: z.string(),
  })
  .openapi("DashboardSummaryResponse");

const json = (schema: z.ZodType, description: string) => ({ content: { "application/json": { schema } }, description });

const summaryRoute = createRoute({
  method: "get",
  path: "/dashboard/summary",
  tags: ["Dashboard"],
  summary: "Ringkasan dashboard sesuai peran dan fase (P0: administrasi)",
  security: [{ bearerAuth: [] }],
  responses: {
    200: json(Summary, "Ringkasan"),
    401: json(ErrorResponse, "UNAUTHORIZED atau TOKEN_EXPIRED"),
    403: json(ErrorResponse, "FORBIDDEN (tanpa dashboard.view tingkat FULL/TEAM) atau ACCOUNT_DEACTIVATED"),
  },
});

export function registerDashboard(v1: OpenAPIHono<AuthEnv>, deps: { auth?: AuthVerifier | undefined; db?: Db | undefined }) {
  v1.use("/dashboard/summary", authenticate(deps), requirePermission("dashboard.view"));

  v1.openapi(summaryRoute, async (c) => {
    const identity = c.get("identity");
    const data = await withUser(
      deps.db as Db,
      identity.userId,
      async (tx) => {
        const now = await tx.query<{ now: Date }>("select now() as now");
        if (!identity.permissions.has("user.manage")) return { as_of: now.rows[0]?.now ?? new Date(), administration: undefined };
        // RLS: Company Admin melihat seluruh pengguna dan pekerja organisasinya saja
        const users = await tx.query<{ status: string; n: number }>(
          "select status, count(*)::int as n from user_profile where organization_id = $1 group by status",
          [identity.organizationId],
        );
        const workers = await tx.query<{ total: number; with_account: number; missing_job_position: number }>(
          `select count(*)::int as total,
                  count(*) filter (where user_id is not null)::int as with_account,
                  count(*) filter (where job_position_id is null)::int as missing_job_position
           from worker where organization_id = $1 and deleted_at is null and worker_status in ('ACTIVE', 'SUSPENDED')`,
          [identity.organizationId],
        );
        const by = Object.fromEntries(users.rows.map((r) => [r.status, r.n]));
        return {
          as_of: now.rows[0]?.now ?? new Date(),
          administration: {
            users: {
              active: by.ACTIVE ?? 0,
              invited: by.INVITED ?? 0,
              locked: by.LOCKED ?? 0,
              deactivated: by.DEACTIVATED ?? 0,
            },
            workers: workers.rows[0] ?? { total: 0, with_account: 0, missing_job_position: 0 },
          },
        };
      },
      identity.ctx,
    );
    return c.json(
      {
        success: true as const,
        data: {
          as_of: data.as_of.toISOString(),
          scope: { organization_id: identity.organizationId },
          ...(data.administration ? { administration: data.administration } : {}),
        },
        request_id: c.get("requestId"),
      },
      200,
    );
  });
}

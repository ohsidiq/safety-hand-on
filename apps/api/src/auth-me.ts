import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "@soh/db";
import { withUser } from "@soh/db";
import { type AuthEnv, type AuthVerifier, authenticate } from "./auth.js";

/** GET /api/v1/auth/me (API-001 bagian 9). `permissions` hanya untuk tampilan menu (AUTH-API-010). */

const ErrorResponse = z
  .object({
    success: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
    request_id: z.string(),
  })
  .openapi("ErrorResponse");

const RoleAssignment = z
  .object({
    id: z.uuid(),
    role_code: z.string().openapi({ example: "SUPERVISOR" }),
    scope_type: z.enum(["PLATFORM", "ORGANIZATION", "SITE", "DEPARTMENT", "TEAM", "CONTRACTOR", "SELF"]),
    scope_id: z.uuid().nullable(),
    valid_until: z.string().nullable(),
  })
  .openapi("RoleAssignment");

const Me = z
  .object({
    user_id: z.uuid(),
    organization: z.object({ id: z.uuid(), name: z.string(), code: z.string().nullable() }).nullable(),
    full_name: z.string().nullable(),
    worker_id: z.uuid().nullable(),
    language: z.enum(["id", "en"]),
    role_assignments: z.array(RoleAssignment),
    permissions: z.array(z.string()).openapi({ example: ["worker.read", "readiness.read"] }),
    mfa_enabled: z.boolean(),
    must_change_credential: z.boolean(),
  })
  .openapi("Me");

const MeResponse = z.object({ success: z.literal(true), data: Me, request_id: z.string() }).openapi("MeResponse");

const json = (schema: z.ZodType, description: string) => ({ content: { "application/json": { schema } }, description });

const meRoute = createRoute({
  method: "get",
  path: "/auth/me",
  tags: ["Auth"],
  summary: "Identitas pemanggil: profil, penugasan role aktif, permission efektif",
  security: [{ bearerAuth: [] }],
  responses: {
    200: json(MeResponse, "Identitas pengguna yang sedang login"),
    401: json(ErrorResponse, "UNAUTHORIZED atau TOKEN_EXPIRED"),
    403: json(ErrorResponse, "ACCOUNT_DEACTIVATED"),
    423: json(ErrorResponse, "ACCOUNT_LOCKED"),
    503: json(ErrorResponse, "Autentikasi atau database belum tersedia"),
  },
});

export function registerAuthMe(v1: OpenAPIHono<AuthEnv>, deps: { auth?: AuthVerifier | undefined; db?: Db | undefined }) {
  v1.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description: "Token akses Supabase Auth",
  });

  v1.use("/auth/me", authenticate(deps));

  v1.openapi(meRoute, async (c) => {
    const identity = c.get("identity");
    const db = deps.db as Db; // dijamin ada oleh authenticate
    const data = await withUser(db, identity.userId, async (tx) => {
      const p = await tx.query<{ full_name: string | null; preferred_language: "id" | "en"; mfa_enabled: boolean }>(
        "select full_name, preferred_language, mfa_enabled from user_profile where id = $1",
        [identity.userId],
      );
      const org = identity.organizationId
        ? await tx.query<{ id: string; name: string; code: string | null }>(
            "select id, name, code from organization where id = $1",
            [identity.organizationId],
          )
        : undefined;
      const worker = await tx.query<{ id: string | null }>("select app.my_worker_id() as id");
      const roles = await tx.query<{
        id: string;
        role_code: string;
        scope_type: z.infer<typeof RoleAssignment>["scope_type"];
        scope_id: string | null;
        valid_until: Date | null;
      }>(
        `select id, role_code, scope_type, scope_id, valid_until from user_role_assignment
         where user_id = $1 and revoked_at is null and valid_from <= now() and (valid_until is null or valid_until > now())
         order by role_code, scope_type, scope_id`,
        [identity.userId],
      );
      const profile = p.rows[0];
      return {
        user_id: identity.userId,
        organization: org?.rows[0] ?? null,
        full_name: profile?.full_name ?? null,
        worker_id: worker.rows[0]?.id ?? null,
        language: profile?.preferred_language ?? "id",
        role_assignments: roles.rows.map((r) => ({ ...r, valid_until: r.valid_until?.toISOString() ?? null })),
        permissions: [...identity.permissions].sort(),
        mfa_enabled: profile?.mfa_enabled ?? false,
        must_change_credential: false, // kredensial PIN pekerja belum ada (login lapangan menyusul)
      };
    });
    return c.json({ success: true as const, data, request_id: c.get("requestId") }, 200);
  });
}

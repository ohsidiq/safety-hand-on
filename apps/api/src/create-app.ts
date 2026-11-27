import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "@soh/db";
import { checkDatabase } from "@soh/db";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { registerAuditLogs } from "./audit-logs.js";
import type { AuthEnv, AuthVerifier } from "./auth.js";
import { registerAuthMe } from "./auth-me.js";
import { registerAuthorizations } from "./authorizations.js";
import { registerCompetencies } from "./competencies.js";
import { registerDashboard } from "./dashboard.js";
import { type ErrorCode, errorBody, errorStatus } from "./errors.js";
import { registerFiles } from "./files.js";
import { registerMedical } from "./medical.js";
import { registerMedicalClearance } from "./medical-clearance.js";
import type { NationalIdCrypto } from "./national-id.js";
import { registerNotifications } from "./notifications.js";
import { registerOrgStructure } from "./org-structure.js";
import { registerSimpers } from "./simpers.js";
import { type PushSender, registerSpikePush } from "./spike-push.js";
import type { FileStorage } from "./storage.js";
import { registerWorkerImport } from "./worker-import.js";
import { registerWorkers } from "./workers.js";

/**
 * Core API Safety On Hand (ADR-001 Opsi B).
 * Konvensi mengikuti API-000: basis /api/v1, amplop respons, X-Request-Id, katalog galat,
 * health tanpa autentikasi dan tanpa detail internal.
 */

export const API_VERSION = "0.1.0";

export interface AppDeps {
  /** Pool database. Boleh kosong saat uji unit; /health/ready lalu melapor tidak siap. */
  db?: Db | undefined;
  allowedOrigins?: string[] | undefined;
  /** SPIKE S-6: pengirim Web Push. Kosong = endpoint spike menjawab 404. */
  pushSender?: PushSender | undefined;
  /** Verifier token Supabase Auth. Kosong = endpoint terlindungi menjawab 503. */
  auth?: AuthVerifier | undefined;
  /** Sandi NIK (API-003 WF-API-005). Kosong = NIK tidak dapat disimpan (503), data pekerja lain tetap berjalan. */
  nationalId?: NationalIdCrypto | undefined;
  /** Penyimpanan berkas privat (API-000 §14). Kosong = endpoint file menjawab 503. */
  storage?: FileStorage | undefined;
}

type Env = AuthEnv;

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

const HealthData = z
  .object({
    status: z.enum(["UP", "DOWN"]).openapi({ example: "UP" }),
  })
  .openapi("HealthStatus");

const HealthResponse = z
  .object({
    success: z.boolean(),
    data: HealthData,
    request_id: z.string(),
  })
  .openapi("HealthResponse");

const liveRoute = createRoute({
  method: "get",
  path: "/health/live",
  tags: ["Health"],
  summary: "Liveness: proses Core API berjalan",
  responses: {
    200: { content: { "application/json": { schema: HealthResponse } }, description: "Proses hidup" },
  },
});

const readyRoute = createRoute({
  method: "get",
  path: "/health/ready",
  tags: ["Health"],
  summary: "Readiness: dependensi (database) siap",
  responses: {
    200: { content: { "application/json": { schema: HealthResponse } }, description: "Siap melayani" },
    503: { content: { "application/json": { schema: HealthResponse } }, description: "Belum siap" },
  },
});

export function createApp(deps: AppDeps = {}) {
  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(errorBody("VALIDATION_ERROR", c.get("requestId")), 422);
      }
    },
  });

  app.use("*", async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const requestId = incoming && REQUEST_ID_RE.test(incoming) ? incoming : crypto.randomUUID();
    c.set("requestId", requestId);
    await next();
    c.header("X-Request-Id", requestId);
  });
  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      origin: deps.allowedOrigins ?? [],
      allowHeaders: ["Authorization", "Content-Type", "X-Request-Id", "Idempotency-Key", "If-Match", "X-Access-Reason"],
      exposeHeaders: ["X-Request-Id"],
    }),
  );

  // Hook validasi juga dipasang di sub-aplikasi v1: rute terdaftar di sini, bukan di `app`.
  const v1 = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(errorBody("VALIDATION_ERROR", c.get("requestId")), 422);
      }
    },
  });

  v1.openapi(liveRoute, (c) => c.json({ success: true, data: { status: "UP" as const }, request_id: c.get("requestId") }, 200));

  v1.openapi(readyRoute, async (c) => {
    let up = false;
    if (deps.db) {
      try {
        up = (await checkDatabase(deps.db)).ok;
      } catch (err) {
        up = false; // respons tanpa detail internal (API-000 bagian 18)
        // Log hanya kode galat (mis. 28P01, ECONNREFUSED, SELF_SIGNED_CERT_IN_CHAIN), tanpa pesan/URL/kredensial.
        const e = err as { code?: unknown; name?: unknown };
        console.error(
          JSON.stringify({
            level: "error",
            msg: "readiness db check failed",
            code: typeof e.code === "string" ? e.code : undefined,
            name: typeof e.name === "string" ? e.name : undefined,
            request_id: c.get("requestId"),
          }),
        );
      }
    }
    const body = { success: up, data: { status: up ? ("UP" as const) : ("DOWN" as const) }, request_id: c.get("requestId") };
    return up ? c.json(body, 200) : c.json(body, 503);
  });

  registerAuthMe(v1, deps);
  registerAuditLogs(v1, deps);
  registerDashboard(v1, deps);
  registerNotifications(v1, deps);
  // sebelum struktur organisasi: /competencies/pending-verification harus cocok sebelum /competencies/{id}
  registerCompetencies(v1, deps);
  registerAuthorizations(v1, deps);
  registerSimpers(v1, deps);
  registerMedical(v1, deps);
  registerMedicalClearance(v1, deps);
  registerOrgStructure(v1, deps);
  registerFiles(v1, deps);
  registerWorkerImport(v1, deps);
  registerWorkers(v1, deps);
  registerSpikePush(v1, deps.pushSender);

  app.route("/api/v1", v1);

  app.doc31("/api/v1/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Safety On Hand Core API",
      version: API_VERSION,
      description: "Kontrak API v1 (ARCH-003). Data sintetis saja sampai syarat B-24 terpenuhi.",
    },
    servers: [{ url: "/" }],
  });

  app.notFound((c) => fail(c, "NOT_FOUND"));
  app.onError((_err, c) => fail(c, "INTERNAL_ERROR"));

  return app;
}

function fail(c: { get: (k: "requestId") => string; json: (b: unknown, s: number) => Response }, code: ErrorCode) {
  return c.json(errorBody(code, c.get("requestId")), errorStatus[code]);
}

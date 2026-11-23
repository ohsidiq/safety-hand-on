import type { Db, RequestContext } from "@soh/db";
import { withUser } from "@soh/db";
import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, type JWTVerifyGetKey, errors as joseErrors, jwtVerify } from "jose";
import { type ErrorCode, errorBody, errorStatus } from "./errors.js";

/**
 * Autentikasi Core API (API-001, SRS-PLT01).
 * - Token akses diterbitkan Supabase Auth dan diverifikasi dengan kunci publik JWKS (ES256/RS256).
 *   Tidak ada rahasia JWT yang disimpan di Core API.
 * - Dari token hanya `sub` (= user_profile.id) yang dipakai. Role, scope, status akun, dan permission
 *   dibaca dari database pada setiap permintaan (AUTH-API-007), jadi pencabutan berlaku seketika.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALGORITHMS = ["ES256", "RS256"];

export class AuthError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}

export interface AuthVerifier {
  /** Mengembalikan id pengguna, atau melempar AuthError (UNAUTHORIZED, TOKEN_EXPIRED, SERVICE_UNAVAILABLE). */
  verify(token: string): Promise<{ userId: string; sessionId?: string | undefined }>;
}

export interface JwtVerifierOptions {
  keys: JWTVerifyGetKey;
  issuer: string;
  audience: string;
}

export function createJwtVerifier(opts: JwtVerifierOptions): AuthVerifier {
  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, opts.keys, {
          issuer: opts.issuer,
          audience: opts.audience,
          algorithms: ALGORITHMS,
          clockTolerance: 5,
          requiredClaims: ["sub", "exp"],
        });
        if (typeof payload.sub !== "string" || !UUID_RE.test(payload.sub)) throw new AuthError("UNAUTHORIZED");
        // session_id (Supabase Auth): dipakai untuk mencatat login pertama sesi (AUD-007)
        const sid = typeof payload.session_id === "string" && UUID_RE.test(payload.session_id) ? payload.session_id : undefined;
        return { userId: payload.sub.toLowerCase(), sessionId: sid?.toLowerCase() };
      } catch (err) {
        if (err instanceof AuthError) throw err;
        if (err instanceof joseErrors.JWTExpired) throw new AuthError("TOKEN_EXPIRED");
        // JWKS tidak terjangkau: masalah layanan, bukan kesalahan pemanggil
        if (err instanceof joseErrors.JWKSTimeout || !(err instanceof joseErrors.JOSEError)) {
          throw new AuthError("SERVICE_UNAVAILABLE");
        }
        throw new AuthError("UNAUTHORIZED");
      }
    },
  };
}

/**
 * Verifier dari variabel lingkungan. SUPABASE_URL bukan rahasia (URL proyek). Kosong = autentikasi
 * tidak dikonfigurasi dan endpoint terlindungi menjawab 503.
 */
export function authVerifierFromEnv(
  supabaseUrl = process.env.SUPABASE_URL,
  audience = process.env.AUTH_AUDIENCE || "authenticated",
): AuthVerifier | undefined {
  if (!supabaseUrl) return undefined;
  let base: URL;
  try {
    base = new URL(supabaseUrl);
  } catch {
    console.error(JSON.stringify({ level: "error", msg: "auth not configured", code: "SUPABASE_URL_INVALID" }));
    return undefined;
  }
  const local = base.hostname === "localhost" || base.hostname === "127.0.0.1";
  if (base.protocol !== "https:" && !local) {
    console.error(JSON.stringify({ level: "error", msg: "auth not configured", code: "SUPABASE_URL_NOT_HTTPS" }));
    return undefined;
  }
  const root = base.origin;
  return createJwtVerifier({
    keys: createRemoteJWKSet(new URL(`${root}/auth/v1/.well-known/jwks.json`), {
      timeoutDuration: 5000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    }),
    issuer: `${root}/auth/v1`,
    audience,
  });
}

// ---------------------------------------------------------------- identitas pemanggil

export interface Identity {
  userId: string;
  organizationId: string | null;
  /** Permission efektif (constraint FULL/TEAM). LIMITED/SELF ditolak bawaan sampai aturannya dibangun. */
  permissions: ReadonlySet<string>;
  /** Konteks permintaan untuk audit (request_id, IP, perangkat). */
  ctx: RequestContext;
}

export type AuthEnv = { Variables: { requestId: string; identity: Identity } };

/** IP klien: header proxy tepercaya Vercel (x-forwarded-for elemen pertama) atau x-real-ip. */
export function clientIp(header: (name: string) => string | undefined): string | undefined {
  const fwd = header("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || header("x-real-ip")?.trim() || undefined;
}

/**
 * Membaca status akun dan permission pengguna lewat withUser (RLS aktif, ARCH-002).
 * Sesi Supabase yang pertama kali dipakai oleh akun ACTIVE dicatat sebagai auth.login_success.
 */
export async function loadIdentity(
  db: Db,
  userId: string,
  opts: { sessionId?: string | undefined; ctx?: RequestContext } = {},
): Promise<{ status: string | null; identity: Identity }> {
  const ctx = opts.ctx ?? {};
  return withUser(
    db,
    userId,
    async (tx) => {
      const p = await tx.query<{ status: string; organization_id: string | null }>(
        "select status, organization_id from user_profile where id = $1",
        [userId],
      );
      if (p.rows[0]?.status === "ACTIVE" && opts.sessionId) {
        await tx.query("select app.audit_session_seen($1)", [opts.sessionId]);
      }
      const perms = await tx.query<{ permission_code: string }>(
        "select distinct permission_code from app.my_permissions() where constraint_level in ('FULL', 'TEAM')",
      );
      const row = p.rows[0];
      return {
        status: row?.status ?? null,
        identity: {
          userId,
          organizationId: row?.organization_id ?? null,
          permissions: new Set(perms.rows.map((r) => r.permission_code)),
          ctx,
        },
      };
    },
    ctx,
  );
}

function deny(c: Parameters<MiddlewareHandler<AuthEnv>>[0], code: ErrorCode) {
  if (errorStatus[code] === 401) c.header("WWW-Authenticate", 'Bearer realm="soh"');
  return c.json(errorBody(code, c.get("requestId")), errorStatus[code]);
}

function logAuthIssue(code: string, requestId: string) {
  console.error(JSON.stringify({ level: "error", msg: "auth unavailable", code, request_id: requestId }));
}

/** Middleware: wajib token Bearer yang sah dan akun ACTIVE. Mengisi c.var.identity. */
export function authenticate(deps: { auth?: AuthVerifier | undefined; db?: Db | undefined }): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (!deps.auth || !deps.db) {
      logAuthIssue(deps.auth ? "DB_NOT_CONFIGURED" : "AUTH_NOT_CONFIGURED", c.get("requestId"));
      return deny(c, "SERVICE_UNAVAILABLE");
    }
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header);
    if (!match?.[1]) return deny(c, "UNAUTHORIZED");

    let userId: string;
    let sessionId: string | undefined;
    try {
      ({ userId, sessionId } = await deps.auth.verify(match[1]));
    } catch (err) {
      const code = err instanceof AuthError ? err.code : "UNAUTHORIZED";
      if (code === "SERVICE_UNAVAILABLE") logAuthIssue("JWKS_UNAVAILABLE", c.get("requestId"));
      return deny(c, code);
    }

    const ctx: RequestContext = {
      requestId: c.get("requestId"),
      ip: clientIp((n) => c.req.header(n)),
      userAgent: c.req.header("user-agent"),
    };
    const { status, identity } = await loadIdentity(deps.db, userId, { sessionId, ctx });
    // Akun tidak ada atau belum aktif (undangan belum diterima) dijawab sama: tidak membocorkan keberadaan akun
    if (status === null || status === "INVITED") return deny(c, "UNAUTHORIZED");
    if (status === "DEACTIVATED") return deny(c, "ACCOUNT_DEACTIVATED");
    if (status === "LOCKED") return deny(c, "ACCOUNT_LOCKED");
    if (status !== "ACTIVE") return deny(c, "UNAUTHORIZED");

    c.set("identity", identity);
    await next();
  };
}

/**
 * Pemeriksaan permission di server (FR-PLT01-010, AC-PLT01-006): tanpa permission -> 403 FORBIDDEN.
 * Scope objek tetap ditegakkan RLS dan pemeriksaan per endpoint (403 SCOPE_DENIED atau 404).
 */
export function requirePermission(permission: string): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (!c.get("identity")?.permissions.has(permission)) return deny(c, "FORBIDDEN");
    await next();
  };
}

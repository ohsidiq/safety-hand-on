import { generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { authVerifierFromEnv, createJwtVerifier } from "../src/auth.js";
import { createApp } from "../src/create-app.js";
import { AUDIENCE, ISSUER, makeIssuer } from "./jwt-helper.js";

const USER = "11111111-2222-4333-8444-555555555555";

describe("verifikasi token Supabase Auth (API-001)", () => {
  let issuer: Awaited<ReturnType<typeof makeIssuer>>;
  beforeAll(async () => {
    issuer = await makeIssuer();
  });

  const codeOf = (p: Promise<unknown>) =>
    p.then(
      () => "OK",
      (e: { code?: string }) => e.code,
    );

  it("token sah mengembalikan id pengguna dari klaim sub", async () => {
    await expect(issuer.verifier.verify(await issuer.sign({ sub: USER }))).resolves.toEqual({ userId: USER });
  });

  it("token kedaluwarsa -> TOKEN_EXPIRED", async () => {
    const t = await issuer.sign({ sub: USER }, { exp: Math.floor(Date.now() / 1000) - 60 });
    expect(await codeOf(issuer.verifier.verify(t))).toBe("TOKEN_EXPIRED");
  });

  it("issuer atau audience lain -> UNAUTHORIZED", async () => {
    const a = await issuer.sign({ sub: USER }, { iss: "https://lain.supabase.co/auth/v1" });
    const b = await issuer.sign({ sub: USER }, { aud: "anon" });
    expect(await codeOf(issuer.verifier.verify(a))).toBe("UNAUTHORIZED");
    expect(await codeOf(issuer.verifier.verify(b))).toBe("UNAUTHORIZED");
  });

  it("ditandatangani kunci lain -> UNAUTHORIZED", async () => {
    const other = await makeIssuer();
    expect(await codeOf(issuer.verifier.verify(await other.sign({ sub: USER })))).toBe("UNAUTHORIZED");
  });

  it("algoritma simetris (HS256) dan alg none ditolak", async () => {
    const hs = await new SignJWT({ sub: USER })
      .setProtectedHeader({ alg: "HS256", kid: "uji-1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("rahasia-uji-yang-cukup-panjang-32b"));
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const none = `${enc({ alg: "none" })}.${enc({ sub: USER, iss: ISSUER, aud: AUDIENCE, exp: 9999999999 })}.`;
    expect(await codeOf(issuer.verifier.verify(hs))).toBe("UNAUTHORIZED");
    expect(await codeOf(issuer.verifier.verify(none))).toBe("UNAUTHORIZED");
  });

  it("sub bukan UUID atau tidak ada -> UNAUTHORIZED", async () => {
    expect(await codeOf(issuer.verifier.verify(await issuer.sign({ sub: "admin" })))).toBe("UNAUTHORIZED");
    expect(await codeOf(issuer.verifier.verify(await issuer.sign({})))).toBe("UNAUTHORIZED");
  });

  it("JWKS tidak terjangkau -> SERVICE_UNAVAILABLE, bukan 401", async () => {
    const { privateKey } = await generateKeyPair("ES256");
    const t = await new SignJWT({ sub: USER })
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime("5m")
      .sign(privateKey);
    const broken = createJwtVerifier({
      keys: async () => {
        throw new TypeError("fetch failed");
      },
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(await codeOf(broken.verify(t))).toBe("SERVICE_UNAVAILABLE");
  });

  it("konfigurasi dari lingkungan: kosong atau bukan HTTPS = tidak aktif", () => {
    expect(authVerifierFromEnv("")).toBeUndefined();
    expect(authVerifierFromEnv("http://contoh.supabase.co")).toBeUndefined();
    expect(authVerifierFromEnv("bukan url")).toBeUndefined();
    expect(authVerifierFromEnv("https://contoh.supabase.co")).toBeDefined();
    expect(authVerifierFromEnv("http://localhost:54321")).toBeDefined();
  });
});

describe("GET /api/v1/auth/me tanpa database", () => {
  it("autentikasi belum dikonfigurasi -> 503", async () => {
    const res = await createApp().request("/api/v1/auth/me");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
  });

  it("tanpa header Authorization atau format salah -> 401 dengan WWW-Authenticate", async () => {
    const { verifier } = await makeIssuer();
    // db palsu: tidak boleh tersentuh karena token ditolak lebih dulu
    const app = createApp({ auth: verifier, db: {} as never });
    const cases: Record<string, string>[] = [
      {},
      { Authorization: "Basic abc" },
      { Authorization: "Bearer " },
      { Authorization: "Bearer a b" },
    ];
    for (const headers of cases) {
      const res = await app.request("/api/v1/auth/me", { headers });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
      expect(await res.json()).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
    }
  });

  it("token kedaluwarsa -> 401 TOKEN_EXPIRED", async () => {
    const { verifier, sign } = await makeIssuer();
    const app = createApp({ auth: verifier, db: {} as never });
    const t = await sign({ sub: USER }, { exp: Math.floor(Date.now() / 1000) - 60 });
    const res = await app.request("/api/v1/auth/me", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "TOKEN_EXPIRED" } });
  });

  it("kontrak OpenAPI memuat /auth/me dengan skema bearerAuth", async () => {
    const doc = await (await createApp().request("/api/v1/openapi.json")).json();
    expect(doc.paths["/api/v1/auth/me"].get.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
  });
});

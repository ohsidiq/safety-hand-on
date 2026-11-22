import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { createJwtVerifier } from "../src/auth.js";

/** Penerbit token uji: meniru Supabase Auth (ES256 + JWKS) dengan kunci yang dibuat saat uji. */
export const ISSUER = "https://contoh-proyek.supabase.co/auth/v1";
export const AUDIENCE = "authenticated";

export async function makeIssuer() {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: "uji-1", alg: "ES256", use: "sig" };
  const verifier = createJwtVerifier({ keys: createLocalJWKSet({ keys: [jwk] }), issuer: ISSUER, audience: AUDIENCE });

  async function sign(claims: JWTPayload & { sub?: string }, opts: { exp?: string | number; iss?: string; aud?: string } = {}) {
    return new SignJWT({ role: "authenticated", ...claims })
      .setProtectedHeader({ alg: "ES256", kid: "uji-1" })
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "5m")
      .sign(privateKey);
  }
  return { verifier, sign };
}

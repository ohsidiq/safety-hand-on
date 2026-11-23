import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createNationalIdCrypto, nationalIdCryptoFromEnv, normalizeNationalId } from "../src/national-id.js";

describe("NIK hanya-tulis (API-003 WF-API-005)", () => {
  const c = createNationalIdCrypto(randomBytes(32), randomBytes(32));
  const org = "0f0e7d7c-1111-4222-8333-944455556666";
  const other = "1f0e7d7c-1111-4222-8333-944455556666";

  it("normalisasi: hanya 16 digit, spasi/tanda hubung dibuang", () => {
    expect(normalizeNationalId("3171 0123-4567 8901")).toBe("3171012345678901");
    expect(normalizeNationalId("317101234567890")).toBeNull();
    expect(normalizeNationalId("31710123456789AB")).toBeNull();
  });

  it("sandi acak per penyimpanan, dapat dibuka hanya untuk organisasi yang sama; HMAC deterministik per organisasi", () => {
    const a = c.seal(org, "3171012345678901");
    const b = c.seal(org, "3171012345678901");
    expect(a.encrypted.equals(b.encrypted)).toBe(false);
    expect(a.hash.equals(b.hash)).toBe(true);
    expect(a.encrypted.includes(Buffer.from("3171012345678901"))).toBe(false);
    expect(c.open(org, a.encrypted)).toBe("3171012345678901");
    expect(() => c.open(other, a.encrypted)).toThrow();
    expect(c.seal(other, "3171012345678901").hash.equals(a.hash)).toBe(false);
  });

  it("kunci dari env: kosong atau salah ukuran -> tidak aktif", () => {
    expect(nationalIdCryptoFromEnv("", "")).toBeUndefined();
    expect(nationalIdCryptoFromEnv(randomBytes(16).toString("base64"), randomBytes(32).toString("base64"))).toBeUndefined();
    expect(nationalIdCryptoFromEnv(randomBytes(32).toString("base64"), randomBytes(32).toString("base64"))).toBeDefined();
  });
});

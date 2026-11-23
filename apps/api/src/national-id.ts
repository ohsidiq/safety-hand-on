import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * NIK (national_id) hanya-tulis (API-003 §2, WF-API-005, DB-008, B-13).
 * - Disimpan terenkripsi AES-256-GCM. Format: versi(1) || iv(12) || tag(16) || ciphertext. AAD = organization_id,
 *   sehingga sandi tidak dapat dipindah ke tenant lain.
 * - Duplikat diperiksa lewat HMAC-SHA256(organization_id ":" NIK) dengan kunci terpisah (indeks unik per organisasi).
 * - Kunci dari variabel lingkungan (ARCH-009). Tanpa kunci, NIK tidak dapat disimpan (503), data lain tetap jalan.
 * - Nilai NIK tidak pernah dikembalikan, dicatat di log, atau masuk audit (hanya nama field).
 */

const VERSION = 1;
const NIK_RE = /^\d{16}$/;

export interface NationalIdCrypto {
  seal(organizationId: string, nik: string): { encrypted: Buffer; hash: Buffer };
  /** Hanya untuk uji dan kebutuhan masa depan dengan permission khusus (belum ada endpoint pembaca, API-003 §2). */
  open(organizationId: string, encrypted: Buffer): string;
}

/** NIK dinormalkan: spasi/tanda hubung dibuang. Mengembalikan null bila bukan 16 digit. */
export function normalizeNationalId(input: string): string | null {
  const v = input.replace(/[\s-]/g, "");
  return NIK_RE.test(v) ? v : null;
}

function decodeKey(value: string | undefined, minBytes: number): Buffer | null {
  if (!value) return null;
  const buf = Buffer.from(value.trim(), "base64");
  return buf.length >= minBytes ? buf : null;
}

export function createNationalIdCrypto(encKey: Buffer, hmacKey: Buffer): NationalIdCrypto {
  if (encKey.length !== 32) throw new Error("kunci enkripsi NIK harus 32 byte");
  if (hmacKey.length < 32) throw new Error("kunci HMAC NIK minimal 32 byte");
  return {
    seal(organizationId, nik) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encKey, iv);
      cipher.setAAD(Buffer.from(organizationId, "utf8"));
      const ct = Buffer.concat([cipher.update(nik, "utf8"), cipher.final()]);
      const encrypted = Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
      const hash = createHmac("sha256", hmacKey).update(`${organizationId}:${nik}`).digest();
      return { encrypted, hash };
    },
    open(organizationId, encrypted) {
      if (encrypted[0] !== VERSION) throw new Error("versi sandi NIK tidak dikenal");
      const iv = encrypted.subarray(1, 13);
      const tag = encrypted.subarray(13, 29);
      const decipher = createDecipheriv("aes-256-gcm", encKey, iv);
      decipher.setAAD(Buffer.from(organizationId, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted.subarray(29)), decipher.final()]).toString("utf8");
    },
  };
}

/** Dari NATIONAL_ID_ENC_KEY (base64, 32 byte) dan NATIONAL_ID_HMAC_KEY (base64, >= 32 byte). Kosong -> undefined. */
export function nationalIdCryptoFromEnv(
  enc = process.env.NATIONAL_ID_ENC_KEY,
  mac = process.env.NATIONAL_ID_HMAC_KEY,
): NationalIdCrypto | undefined {
  const encKey = decodeKey(enc, 32);
  const hmacKey = decodeKey(mac, 32);
  if (encKey?.length !== 32 || !hmacKey) {
    if (enc || mac)
      console.error(JSON.stringify({ level: "error", msg: "national id keys invalid", code: "NATIONAL_ID_KEYS_INVALID" }));
    return undefined;
  }
  return createNationalIdCrypto(encKey, hmacKey);
}

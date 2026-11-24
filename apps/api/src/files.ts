import { createHash, randomUUID } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { authenticate } from "./auth.js";
import {
  ApiFailure,
  baseErrors,
  type Deps,
  ErrorResponse,
  json,
  ok,
  type Row,
  respondFailure,
  run,
  security,
  serialize,
  type V1,
} from "./route-kit.js";
import { type FileStorage, StorageError } from "./storage.js";

/**
 * Alur file privat (API-000 §14, DB-008 §3.1-§3.2).
 * 1. POST /files -> metadata PENDING + URL unggah bertanda tangan (klien PUT langsung ke bucket privat).
 * 2. POST /files/{id}/complete -> pemeriksaan isi: ada, ukuran sama, tanda tangan berkas sesuai jenis, SHA-256 -> CLEAN/FAILED.
 * 3. GET /files/{id}/download-url -> URL bertanda tangan pendek (Sensitif 60 detik, lainnya 300 detik), teraudit.
 * Keputusan P0 (Lanjutan 67): tanpa antivirus; pemeriksaan isi menggantikannya sampai sebelum data nyata (B-24).
 * M3.1: hanya pengunggah yang melihat dan mengunduh berkasnya; akses lewat record pemilik ditambahkan per modul (M3.2+).
 */

export type FileDeps = Deps & { storage?: FileStorage | undefined };

export const MIME_LIMITS: Record<string, number> = {
  "application/pdf": 10 * 1024 * 1024,
  "image/jpeg": 20 * 1024 * 1024,
  "image/png": 20 * 1024 * 1024,
  "image/webp": 20 * 1024 * 1024,
};

/** Tujuan -> bucket, klasifikasi, permission unggah (PB-009). Dokumen medis: bucket terpisah, Sensitif. */
export const PURPOSES = {
  COMPETENCY_CERTIFICATE: { bucket: "soh-files", classification: "CONFIDENTIAL", permission: "competency.update" },
  AUTHORIZATION_DOCUMENT: { bucket: "soh-files", classification: "CONFIDENTIAL", permission: "authorization.update" },
  SIMPER_DOCUMENT: { bucket: "soh-files", classification: "CONFIDENTIAL", permission: "simper.update" },
  MEDICAL_DOCUMENT: { bucket: "soh-medical", classification: "SENSITIVE", permission: "medical.update" },
} as const;
type Purpose = keyof typeof PURPOSES;

/** Jenis dari isi (tanda tangan berkas), bukan dari ekstensi (DB-008 §3.1). */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP")
    return "image/webp";
  return null;
}

/** Nama berkas aman untuk unduhan: tanpa jalur, tanpa karakter kendali. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "berkas";
  const cleaned = Array.from(base, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f || '"<>|*?:'.includes(ch) ? "_" : ch;
  })
    .join("")
    .trim();
  return cleaned.slice(0, 120) || "berkas";
}

const FileMeta = z
  .object({
    id: z.uuid(),
    original_name: z.string(),
    mime_type: z.string(),
    size_bytes: z.number().int(),
    purpose: z.enum(Object.keys(PURPOSES) as [Purpose, ...Purpose[]]),
    classification: z.enum(["INTERNAL", "CONFIDENTIAL", "SENSITIVE"]),
    scan_status: z.enum(["PENDING", "CLEAN", "INFECTED", "FAILED"]),
    scan_detail: z.string().nullable(),
    checksum_sha256: z.string().nullable(),
    uploaded_at: z.string(),
    scanned_at: z.string().nullable(),
  })
  .openapi("FileObject");

const COLS = `id, original_name, mime_type, size_bytes::int as size_bytes, purpose, classification, scan_status, scan_detail,
  checksum_sha256, uploaded_at, scanned_at`;

const fileErrors = {
  ...baseErrors,
  404: json(ErrorResponse, "NOT_FOUND"),
  409: json(ErrorResponse, "INVALID_STATE_TRANSITION (sudah diperiksa) atau CONFLICT MISSING_OBJECT (belum diunggah)"),
  422: json(ErrorResponse, "VALIDATION_ERROR (jenis/ukuran tidak diizinkan) atau FILE_NOT_CLEAN"),
  503: json(ErrorResponse, "SERVICE_UNAVAILABLE (penyimpanan belum dikonfigurasi)"),
};

export function registerFiles(v1: V1, deps: FileDeps) {
  const IdParam = z.object({ id: z.uuid() });

  const createFileRoute = createRoute({
    method: "post",
    path: "/files",
    tags: ["Files"],
    summary: "Mendaftarkan berkas dan mendapatkan URL unggah bertanda tangan",
    security,
    middleware: [authenticate(deps)],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                original_name: z.string().trim().min(1).max(200),
                mime_type: z.enum(Object.keys(MIME_LIMITS) as [string, ...string[]]),
                size_bytes: z.number().int().positive(),
                purpose: z.enum(Object.keys(PURPOSES) as [Purpose, ...Purpose[]]),
              })
              .openapi("FileCreate"),
          },
        },
        required: true,
      },
    },
    responses: {
      201: json(
        ok(
          z.object({
            file_id: z.uuid(),
            upload_url: z.string().openapi({ description: "PUT isi berkas ke URL ini (berlaku singkat)" }),
            expires_at: z.string(),
          }),
        ),
        "Berkas terdaftar (PENDING)",
      ),
      ...fileErrors,
    },
  });

  const completeRoute = createRoute({
    method: "post",
    path: "/files/{id}/complete",
    tags: ["Files"],
    summary: "Menandai unggahan selesai: pemeriksaan isi lalu CLEAN atau FAILED",
    security,
    middleware: [authenticate(deps)],
    request: { params: IdParam },
    responses: { 200: json(ok(FileMeta), "Hasil pemeriksaan"), ...fileErrors },
  });

  const getRoute = createRoute({
    method: "get",
    path: "/files/{id}",
    tags: ["Files"],
    summary: "Metadata berkas",
    security,
    middleware: [authenticate(deps)],
    request: { params: IdParam },
    responses: { 200: json(ok(FileMeta), "Metadata"), ...baseErrors, 404: json(ErrorResponse, "NOT_FOUND") },
  });

  const downloadRoute = createRoute({
    method: "get",
    path: "/files/{id}/download-url",
    tags: ["Files"],
    summary: "URL unduh bertanda tangan berumur pendek (teraudit)",
    security,
    middleware: [authenticate(deps)],
    request: { params: IdParam },
    responses: {
      200: json(ok(z.object({ url: z.string(), expires_in: z.number().int() })), "URL unduh"),
      ...fileErrors,
    },
  });

  const needStorage = (): FileStorage => {
    if (!deps.storage) throw new ApiFailure("SERVICE_UNAVAILABLE", [{ field: "storage", issue: "not_configured" }]);
    return deps.storage;
  };

  v1.openapi(createFileRoute, async (c) => {
    const b = c.req.valid("json");
    const identity = c.get("identity");
    const p = PURPOSES[b.purpose];
    if (!identity.permissions.has(p.permission)) return respondFailure(c, new ApiFailure("FORBIDDEN"));
    const limit = MIME_LIMITS[b.mime_type] ?? 0;
    if (b.size_bytes > limit)
      return respondFailure(c, new ApiFailure("VALIDATION_ERROR", [{ field: "size_bytes", issue: `max_${limit}` }]));
    let storage: FileStorage;
    try {
      storage = needStorage();
    } catch (e) {
      return respondFailure(c, e as ApiFailure);
    }
    const id = randomUUID();
    const path = `${identity.organizationId}/${b.purpose.toLowerCase()}/${id}`;
    const r = await run(c, deps, async (tx) => {
      await tx.query(
        `insert into file_object (id, organization_id, bucket, object_path, original_name, mime_type, size_bytes, classification,
                                  purpose, uploaded_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          id,
          identity.organizationId,
          p.bucket,
          path,
          b.original_name,
          b.mime_type,
          b.size_bytes,
          p.classification,
          b.purpose,
          identity.userId,
        ],
      );
      // URL dibuat di dalam transaksi: bila penyimpanan gagal, metadata ikut batal
      try {
        return await storage.createUploadUrl(p.bucket, path);
      } catch (err) {
        if (err instanceof StorageError) throw new ApiFailure("SERVICE_UNAVAILABLE", [{ field: "storage", issue: "upstream" }]);
        throw err;
      }
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("Location", `/api/v1/files/${id}`);
    return c.json(
      { success: true, data: { file_id: id, upload_url: r.url, expires_at: r.expiresAt }, request_id: c.get("requestId") },
      201,
    );
  });

  v1.openapi(completeRoute, async (c) => {
    const { id } = c.req.valid("param");
    let storage: FileStorage;
    try {
      storage = needStorage();
    } catch (e) {
      return respondFailure(c, e as ApiFailure);
    }
    const r = await run(c, deps, async (tx) => {
      const cur = await tx.query<{
        bucket: string;
        object_path: string;
        mime_type: string;
        size_bytes: string;
        scan_status: string;
      }>("select bucket, object_path, mime_type, size_bytes, scan_status from file_object where id = $1", [id]);
      const f = cur.rows[0];
      if (!f) throw new ApiFailure("NOT_FOUND");
      if (f.scan_status !== "PENDING")
        throw new ApiFailure("INVALID_STATE_TRANSITION", [{ field: "scan_status", issue: `already_${f.scan_status}` }]);
      const declared = Number(f.size_bytes);
      let buf: Buffer | null;
      try {
        buf = await storage.read(f.bucket, f.object_path, declared);
      } catch (err) {
        if (err instanceof StorageError) throw new ApiFailure("SERVICE_UNAVAILABLE", [{ field: "storage", issue: "upstream" }]);
        throw err;
      }
      let status = "CLEAN";
      let detail: string | null = null;
      let checksum: string | null = null;
      if (!buf) {
        // belum diunggah: tetap PENDING, klien boleh mencoba lagi
        throw new ApiFailure("CONFLICT", [{ field: "file", issue: "MISSING_OBJECT" }]);
      }
      if (buf.length > declared) [status, detail] = ["FAILED", "TOO_LARGE"];
      else if (buf.length !== declared) [status, detail] = ["FAILED", "SIZE_MISMATCH"];
      else if (sniffMime(buf) !== f.mime_type) [status, detail] = ["FAILED", "TYPE_MISMATCH"];
      else checksum = createHash("sha256").update(buf).digest("hex");
      // hanya dari PENDING (kebijakan file_object_scan); permintaan bersamaan -> 0 baris
      const upd = await tx.query(
        `update file_object set scan_status = $2, scan_detail = $3, checksum_sha256 = $4, scanned_at = now()
         where id = $1 and scan_status = 'PENDING' returning ${COLS}`,
        [id, status, detail, checksum],
      );
      if (!upd.rows[0]) throw new ApiFailure("INVALID_STATE_TRANSITION", [{ field: "scan_status", issue: "already_checked" }]);
      return upd.rows[0] as Row;
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return c.json({ success: true, data: serialize(r), request_id: c.get("requestId") }, 200);
  });

  v1.openapi(getRoute, async (c) => {
    const { id } = c.req.valid("param");
    const r = await run(c, deps, async (tx) => {
      const res = await tx.query(`select ${COLS} from file_object where id = $1`, [id]);
      if (!res.rows[0]) throw new ApiFailure("NOT_FOUND");
      return res.rows[0] as Row;
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    return c.json({ success: true, data: serialize(r), request_id: c.get("requestId") }, 200);
  });

  v1.openapi(downloadRoute, async (c) => {
    const { id } = c.req.valid("param");
    let storage: FileStorage;
    try {
      storage = needStorage();
    } catch (e) {
      return respondFailure(c, e as ApiFailure);
    }
    const r = await run(c, deps, async (tx) => {
      const res = await tx.query<{
        bucket: string;
        object_path: string;
        original_name: string;
        classification: string;
        scan_status: string;
      }>("select bucket, object_path, original_name, classification, scan_status from file_object where id = $1", [id]);
      const f = res.rows[0];
      if (!f) throw new ApiFailure("NOT_FOUND");
      // PENDING, FAILED, INFECTED tidak dapat diunduh (DB-008 §3.2)
      if (f.scan_status !== "CLEAN") throw new ApiFailure("FILE_NOT_CLEAN", [{ field: "scan_status", issue: f.scan_status }]);
      const ttl = f.classification === "SENSITIVE" ? 60 : 300;
      await tx.query("select app.audit_record('file.download', 'file_object', $1, null, null, null, null, 'SUCCESS', $2)", [
        id,
        f.classification === "SENSITIVE",
      ]);
      try {
        return {
          url: await storage.createDownloadUrl(f.bucket, f.object_path, ttl, safeFileName(f.original_name)),
          expires_in: ttl,
        };
      } catch (err) {
        if (err instanceof StorageError) throw new ApiFailure("SERVICE_UNAVAILABLE", [{ field: "storage", issue: "upstream" }]);
        throw err;
      }
    });
    if (r instanceof ApiFailure) return respondFailure(c, r);
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, data: r, request_id: c.get("requestId") }, 200);
  });
}

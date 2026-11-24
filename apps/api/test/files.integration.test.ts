import { createPool, type Db } from "@soh/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/create-app.js";
import { safeFileName, sniffMime } from "../src/files.js";
import { createMemoryStorage, createSupabaseStorage } from "../src/storage.js";
import { makeIssuer } from "./jwt-helper.js";

/** Alur file privat (API-000 §14, DB-008 §3). Unit + integrasi (butuh DATABASE_URL). */

const PDF = Buffer.from("%PDF-1.4\n%sintetis\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);

describe("pemeriksaan isi berkas", () => {
  it("jenis dari tanda tangan berkas, bukan nama", () => {
    expect(sniffMime(PDF)).toBe("application/pdf");
    expect(sniffMime(PNG)).toBe("image/png");
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMime(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]))).toBe("image/webp");
    expect(sniffMime(Buffer.from("MZ\x90\x00 bukan pdf"))).toBeNull();
  });

  it("nama unduhan dibersihkan dari jalur dan karakter kendali", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName('a"b<c>\r\n.pdf')).toBe("a_b_c___.pdf");
    expect(safeFileName("")).toBe("berkas");
  });

  it("klien Supabase Storage: kunci layanan hanya di header, URL bertanda tangan absolut", async () => {
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("/object/upload/sign/"))
        return new Response(JSON.stringify({ url: "/object/upload/sign/soh-files/o/a.pdf?token=t" }));
      return new Response(JSON.stringify({ signedURL: "/object/sign/soh-files/o/a.pdf?token=d" }));
    });
    const s = createSupabaseStorage("https://x.supabase.co/", "rahasia", fetcher as unknown as typeof fetch);
    const up = await s.createUploadUrl("soh-files", "o/a.pdf");
    expect(up.url).toBe("https://x.supabase.co/storage/v1/object/upload/sign/soh-files/o/a.pdf?token=t");
    expect(up.url).not.toContain("rahasia");
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).apikey).toBe("rahasia");
    const dl = await s.createDownloadUrl("soh-files", "o/a.pdf", 60, "Sertifikat A.pdf");
    expect(dl).toBe("https://x.supabase.co/storage/v1/object/sign/soh-files/o/a.pdf?token=d&download=Sertifikat%20A.pdf");
    const signInit = fetcher.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(signInit.body as string)).toEqual({ expiresIn: 60 });
  });
});

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("Alur file (integrasi)", () => {
  let db: Db;
  let issuer: Awaited<ReturnType<typeof makeIssuer>>;
  const storage = createMemoryStorage();
  let app: ReturnType<typeof createApp>;
  let appNoStorage: ReturnType<typeof createApp>;
  const u: Record<string, string> = {};

  const call = async (
    who: string,
    path: string,
    method = "GET",
    body?: unknown,
    a = app,
    // biome-ignore lint/suspicious/noExplicitAny: bentuk respons diperiksa lewat expect
  ): Promise<{ status: number; body: any }> => {
    const res = await a.request(`/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await issuer.sign({ sub: u[who] as string })}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json() };
  };
  const register = (who: string, over: Record<string, unknown> = {}) =>
    call(who, "/files", "POST", {
      original_name: "sertifikat-sintetis.pdf",
      mime_type: "application/pdf",
      size_bytes: PDF.length,
      purpose: "COMPETENCY_CERTIFICATE",
      ...over,
    });
  const pathOf = async (id: string) =>
    (await db.query<{ bucket: string; object_path: string }>("select bucket, object_path from file_object where id = $1", [id]))
      .rows[0] as {
      bucket: string;
      object_path: string;
    };

  beforeAll(async () => {
    db = createPool(url);
    issuer = await makeIssuer();
    app = createApp({ db, auth: issuer.verifier, storage });
    appNoStorage = createApp({ db, auth: issuer.verifier });
    const org = (await db.query<{ id: string }>("select id from organization order by name limit 1")).rows[0]?.id as string;
    for (const who of ["admin", "hseo1", "medis", "spv1", "hsemgr"]) {
      u[who] = (
        await db.query<{ id: string }>("select id from user_profile where organization_id = $1 and email like $2", [
          org,
          `${who}@%`,
        ])
      ).rows[0]?.id as string;
    }
  });

  afterAll(async () => {
    await db?.end();
  });

  it("daftar -> unggah -> complete CLEAN -> unduh bertanda tangan 300 detik, teraudit", async () => {
    const r = await register("hseo1");
    expect(r.status).toBe(201);
    expect(r.body.data.upload_url).toMatch(/^memory:\/\/upload\/soh-files\//);
    const id = r.body.data.file_id;
    const before = await call("hseo1", `/files/${id}/download-url`);
    expect(before.body.error.code).toBe("FILE_NOT_CLEAN");
    expect((await call("hseo1", `/files/${id}/complete`, "POST")).body.error.details[0].issue).toBe("MISSING_OBJECT");
    const p = await pathOf(id);
    storage.put(p.bucket, p.object_path, PDF);
    const done = await call("hseo1", `/files/${id}/complete`, "POST");
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ scan_status: "CLEAN", classification: "CONFIDENTIAL", size_bytes: PDF.length });
    expect(done.body.data.checksum_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await call("hseo1", `/files/${id}/complete`, "POST")).body.error.code).toBe("INVALID_STATE_TRANSITION");
    const dl = await call("hseo1", `/files/${id}/download-url`);
    expect(dl.body.data).toMatchObject({ expires_in: 300 });
    expect(dl.body.data.url).toContain("download=sertifikat-sintetis.pdf");
    const audit = await db.query<{ action: string }>(
      "select payload->>'action' as action from audit_outbox where payload->>'entity_id' = $1 order by created_at",
      [id],
    );
    expect(audit.rows.map((x) => x.action)).toEqual(["file.upload", "file.scan", "file.download"]);
    const text = JSON.stringify((await db.query("select payload from audit_outbox where payload->>'entity_id' = $1", [id])).rows);
    expect(text).not.toContain("sertifikat-sintetis");
  });

  it("isi tidak sesuai jenis atau ukuran -> FAILED dan tidak dapat diunduh", async () => {
    const r = await register("hseo1", { original_name: "palsu.pdf", size_bytes: 20 });
    const p = await pathOf(r.body.data.file_id);
    storage.put(p.bucket, p.object_path, Buffer.from("MZ executable"));
    const done = await call("hseo1", `/files/${r.body.data.file_id}/complete`, "POST");
    expect(done.body.data).toMatchObject({ scan_status: "FAILED", scan_detail: "SIZE_MISMATCH" });
    const r2 = await register("hseo1", { original_name: "palsu2.pdf", size_bytes: 13 });
    const p2 = await pathOf(r2.body.data.file_id);
    storage.put(p2.bucket, p2.object_path, Buffer.from("MZ executable"));
    expect((await call("hseo1", `/files/${r2.body.data.file_id}/complete`, "POST")).body.data).toMatchObject({
      scan_status: "FAILED",
      scan_detail: "TYPE_MISMATCH",
    });
    expect((await call("hseo1", `/files/${r2.body.data.file_id}/download-url`)).body.error.code).toBe("FILE_NOT_CLEAN");
  });

  it("dokumen medis: bucket terpisah, Sensitif, unduh 60 detik; hanya pemegang medical.update", async () => {
    expect((await register("hseo1", { purpose: "MEDICAL_DOCUMENT" })).status).toBe(403);
    const r = await register("medis", { purpose: "MEDICAL_DOCUMENT", original_name: "mcu.pdf" });
    expect(r.status).toBe(201);
    const p = await pathOf(r.body.data.file_id);
    expect(p.bucket).toBe("soh-medical");
    storage.put(p.bucket, p.object_path, PDF);
    expect((await call("medis", `/files/${r.body.data.file_id}/complete`, "POST")).body.data.classification).toBe("SENSITIVE");
    expect((await call("medis", `/files/${r.body.data.file_id}/download-url`)).body.data.expires_in).toBe(60);
    const sens = await db.query<{ s: boolean }>(
      "select (payload->>'sensitive_access')::boolean as s from audit_outbox where payload->>'entity_id' = $1 and payload->>'action' = 'file.download'",
      [r.body.data.file_id],
    );
    expect(sens.rows[0]?.s).toBe(true);
  });

  it("jenis/ukuran di luar daftar putih ditolak; berkas orang lain tidak terlihat; tanpa penyimpanan 503", async () => {
    expect((await register("hseo1", { mime_type: "application/zip" })).status).toBe(422);
    expect((await register("hseo1", { size_bytes: 11 * 1024 * 1024 })).status).toBe(422);
    expect((await register("hseo1", { mime_type: "image/png", size_bytes: 11 * 1024 * 1024 })).status).toBe(201);
    expect((await register("spv1")).status).toBe(403);
    const mine = await register("hseo1");
    expect((await call("admin", `/files/${mine.body.data.file_id}`)).status).toBe(404);
    expect((await call("admin", `/files/${mine.body.data.file_id}/download-url`)).status).toBe(404);
    expect((await call("hseo1", `/files/${mine.body.data.file_id}`)).body.data.scan_status).toBe("PENDING");
    expect(
      (
        await call(
          "hseo1",
          "/files",
          "POST",
          { original_name: "a.pdf", mime_type: "application/pdf", size_bytes: 10, purpose: "COMPETENCY_CERTIFICATE" },
          appNoStorage,
        )
      ).status,
    ).toBe(503);
  });
});

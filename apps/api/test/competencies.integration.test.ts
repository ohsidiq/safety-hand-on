import { createPool, type Db } from "@soh/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/create-app.js";
import { createMemoryStorage } from "../src/storage.js";
import { makeIssuer } from "./jwt-helper.js";

/** Kompetensi pekerja, sertifikat, verifikasi (API-004, SRS-WF003). Butuh DATABASE_URL. Data sintetis saja. */

const PDF = Buffer.from("%PDF-1.4\n%kompetensi sintetis\n%%EOF\n");
const url = process.env.DATABASE_URL;

describe.skipIf(!url)("Kompetensi (integrasi)", () => {
  let db: Db;
  let issuer: Awaited<ReturnType<typeof makeIssuer>>;
  const storage = createMemoryStorage();
  let app: ReturnType<typeof createApp>;
  const u: Record<string, string> = {};
  let org = "";
  let site = "";
  let workerId = "";
  let selfWorkerId = "";
  let otherSiteWorker = "";
  let compId = "";
  const tag = Math.random().toString(36).slice(2, 8);

  const call = async (
    who: string,
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
    // biome-ignore lint/suspicious/noExplicitAny: bentuk respons diperiksa lewat expect
  ): Promise<{ status: number; body: any; etag: string | null }> => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await issuer.sign({ sub: u[who] as string })}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json(), etag: res.headers.get("etag") };
  };
  const one = async (sql: string, params: unknown[] = []) => (await db.query<{ id: string }>(sql, params)).rows[0]?.id as string;
  const today = () => new Date().toISOString().slice(0, 10);
  const plusDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  /** Unggah berkas sertifikat sampai CLEAN; kembalikan file_id. */
  const cleanFile = async (who: string) => {
    const r = await call(who, "/files", "POST", {
      original_name: "sertifikat-kompetensi.pdf",
      mime_type: "application/pdf",
      size_bytes: PDF.length,
      purpose: "COMPETENCY_CERTIFICATE",
    });
    expect(r.status).toBe(201);
    const p = (
      await db.query<{ bucket: string; object_path: string }>("select bucket, object_path from file_object where id = $1", [
        r.body.data.file_id,
      ])
    ).rows[0] as { bucket: string; object_path: string };
    storage.put(p.bucket, p.object_path, PDF);
    expect((await call(who, `/files/${r.body.data.file_id}/complete`, "POST")).body.data.scan_status).toBe("CLEAN");
    return r.body.data.file_id as string;
  };

  const newUser = async (role: string, scopeType: string, scopeId: string | null, name: string) => {
    const id = await one(
      "insert into user_profile (organization_id, email, full_name, status) values ($1, $2, $3, 'ACTIVE') returning id",
      [org, `${name.toLowerCase().replace(/\s/g, "-")}-${tag}@uji.contoh`, name],
    );
    await db.query(
      `insert into user_role_assignment (user_id, organization_id, role_code, scope_type, scope_id, granted_by)
       values ($1, $2, $3, $4, $5, $6)`,
      [id, org, role, scopeType, scopeId, u.admin],
    );
    return id;
  };

  beforeAll(async () => {
    db = createPool(url);
    issuer = await makeIssuer();
    app = createApp({ db, auth: issuer.verifier, storage });
    org = await one("select id from organization order by name limit 1");
    for (const who of ["admin", "hseo1", "spv1", "pekerja1"]) {
      u[who] = await one("select id from user_profile where organization_id = $1 and email like $2", [org, `${who}@%`]);
    }
    site = await one(
      "select scope_id as id from user_role_assignment where user_id = $1 and scope_type = 'SITE' and revoked_at is null limit 1",
      [u.hseo1],
    );
    // pengguna khusus uji ini agar tidak bertabrakan dengan uji paralel
    u.hseo = await newUser("HSE_OFFICER", "SITE", site, "HSE Officer Kompetensi");
    u.mgr = await newUser("HSE_MANAGER", "ORGANIZATION", null, "HSE Manager Kompetensi");
    u.mgr2 = await newUser("HSE_MANAGER", "ORGANIZATION", null, "HSE Manager Dua");
    workerId = await one(
      "select id from worker where site_id = $1 and worker_status = 'ACTIVE' and user_id is null order by sho_id limit 1",
      [site],
    );
    selfWorkerId = await one("select id from worker where user_id = $1", [u.pekerja1]);
    otherSiteWorker = await one(
      "select id from worker where organization_id = $1 and site_id <> $2 and worker_status = 'ACTIVE' limit 1",
      [org, site],
    );
    compId = await one("select id from competency where organization_id = $1 and code = 'CMP-OPR-AB'", [org]);
  });

  afterAll(async () => {
    await db?.end();
  });

  it("master: HSE Officer membaca, tidak mengelola; HSE Manager membuat; kode duplikat 409", async () => {
    const lst = await call("hseo", "/competencies?status=ACTIVE");
    expect(lst.status).toBe(200);
    expect(lst.body.data.map((c: { code: string }) => c.code)).toContain("CMP-OPR-AB");
    const code = `CMP-U${tag.toUpperCase()}`;
    expect((await call("hseo", "/competencies", "POST", { name: "Kompetensi Uji", code })).status).toBe(403);
    const made = await call("mgr", "/competencies", "POST", { name: "Kompetensi Uji", code, default_validity_months: 24 });
    expect(made.status).toBe(201);
    expect(made.body.data).toMatchObject({ code, default_validity_months: 24, status: "ACTIVE" });
    expect((await call("mgr", "/competencies", "POST", { name: "Lagi", code })).body.error.code).toBe("DUPLICATE");
    const off = await call("mgr", `/competencies/${made.body.data.id}/deactivate`, "POST", undefined, { "If-Match": '"1"' });
    expect(off.body.data.status).toBe("INACTIVE");
  });

  it("catat PENDING beserta sertifikat -> pembuat tidak dapat memverifikasi -> HSE Manager memverifikasi", async () => {
    const fileId = await cleanFile("hseo");
    const r = await call("hseo", `/workers/${workerId}/competencies`, "POST", {
      competency_id: compId,
      valid_from: plusDays(-10),
      valid_until: plusDays(700),
      certificates: [
        { certificate_number: `CERT-SINTETIS-${tag}`, issuer: "LSP Sintetis", issue_date: plusDays(-10), file_id: fileId },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      verification_status: "PENDING",
      validity_status: "PENDING_VERIFICATION",
      certificate_count: 1,
      can_verify: false,
    });
    const id = r.body.data.id;
    // HSE Officer: competency.verify LIMITED -> tidak efektif
    expect((await call("hseo", `/worker-competencies/${id}/verify`, "POST", {}, { "If-Match": '"1"' })).status).toBe(403);

    // pembuat yang juga memegang competency.verify tetap ditolak (pemisahan tugas)
    const own = await call("mgr", `/workers/${workerId}/competencies`, "POST", { competency_id: compId, valid_from: today() });
    expect(own.status).toBe(201);
    const sod = await call("mgr", `/worker-competencies/${own.body.data.id}/verify`, "POST", {}, { "If-Match": '"1"' });
    expect(sod.status).toBe(403);
    expect(sod.body.error.code).toBe("SEPARATION_OF_DUTIES");

    const queue = await call("mgr", `/competencies/pending-verification?site_id=${site}&limit=200`);
    expect(queue.status).toBe(200);
    expect(queue.body.data.find((x: { id: string }) => x.id === id)?.can_verify).toBe(true);

    expect((await call("mgr", `/worker-competencies/${id}/verify`, "POST", {}, { "If-Match": '"9"' })).status).toBe(412);
    const v = await call("mgr", `/worker-competencies/${id}/verify`, "POST", { comment: "Sesuai" }, { "If-Match": '"1"' });
    expect(v.status).toBe(200);
    expect(v.body.data).toMatchObject({ verification_status: "VERIFIED", validity_status: "VALID", verified_by: u.mgr });
    expect(v.body.data.verified_by_name).toBe("HSE Manager Kompetensi");
    const again = await call(
      "mgr",
      `/worker-competencies/${id}/reject`,
      "POST",
      { reason: "x" },
      { "If-Match": `"${v.body.data.version}"` },
    );
    expect(again.body.error.code).toBe("INVALID_STATE_TRANSITION");

    // sertifikat terlihat dan dapat diunduh pemverifikasi (bukan pengunggah); unduhan teraudit
    const certs = await call("mgr", `/worker-competencies/${id}/certificates`);
    expect(certs.body.data).toHaveLength(1);
    const dl = await call("mgr", `/competency-certificates/${certs.body.data[0].id}/download-url`);
    expect(dl.status).toBe(200);
    expect(dl.body.data.expires_in).toBe(300);
    const audit = await db.query<{ n: number }>(
      "select count(*)::int as n from audit_outbox where payload->>'entity_id' = $1 and payload->>'action' = 'competency.certificate_download'",
      [id],
    );
    expect(audit.rows[0]?.n).toBe(1);

    // perubahan data inti pada record terverifikasi -> PENDING
    const p = await call(
      "hseo",
      `/worker-competencies/${id}`,
      "PATCH",
      { valid_until: plusDays(20) },
      { "If-Match": `"${v.body.data.version}"` },
    );
    expect(p.status).toBe(200);
    expect(p.body.data).toMatchObject({ verification_status: "PENDING", verified_by: null });

    // tolak wajib alasan, lalu diperbaiki -> PENDING lagi; setelah verifikasi masa berlaku 20 hari -> EXPIRING_SOON
    expect(
      (
        await call(
          "mgr",
          `/worker-competencies/${id}/reject`,
          "POST",
          { reason: "  " },
          { "If-Match": `"${p.body.data.version}"` },
        )
      ).body.error.code,
    ).toBe("REASON_REQUIRED");
    const rj = await call(
      "mgr",
      `/worker-competencies/${id}/reject`,
      "POST",
      { reason: "Nomor tidak terbaca" },
      { "If-Match": `"${p.body.data.version}"` },
    );
    expect(rj.body.data).toMatchObject({
      verification_status: "REJECTED",
      validity_status: "REJECTED",
      rejection_reason: "Nomor tidak terbaca",
    });
    const fixed = await call(
      "hseo",
      `/worker-competencies/${id}`,
      "PATCH",
      { valid_until: plusDays(21) },
      { "If-Match": `"${rj.body.data.version}"` },
    );
    expect(fixed.body.data.verification_status).toBe("PENDING");
    const v2 = await call(
      "mgr2",
      `/worker-competencies/${id}/verify`,
      "POST",
      {},
      { "If-Match": `"${fixed.body.data.version}"` },
    );
    expect(v2.body.data.validity_status).toBe("EXPIRING_SOON");
  });

  it("validasi: rentang tanggal, mulai di masa depan, berkas belum CLEAN, Site lain", async () => {
    const bad = await call("hseo", `/workers/${workerId}/competencies`, "POST", {
      competency_id: compId,
      valid_from: today(),
      valid_until: plusDays(-1),
    });
    expect(bad.body.error.code).toBe("INVALID_DATE_RANGE");
    const future = await call("hseo", `/workers/${workerId}/competencies`, "POST", {
      competency_id: compId,
      valid_from: plusDays(5),
    });
    expect(future.body.error.details[0]).toMatchObject({ field: "valid_from", issue: "in_future" });
    const pending = await call("hseo", "/files", "POST", {
      original_name: "belum.pdf",
      mime_type: "application/pdf",
      size_bytes: PDF.length,
      purpose: "COMPETENCY_CERTIFICATE",
    });
    const nc = await call("hseo", `/workers/${workerId}/competencies`, "POST", {
      competency_id: compId,
      valid_from: today(),
      certificates: [{ issue_date: today(), file_id: pending.body.data.file_id }],
    });
    expect(nc.body.error.code).toBe("FILE_NOT_CLEAN");
    // pekerja Site lain tidak terlihat HSE Officer Site -> 404
    expect(
      (await call("hseo", `/workers/${otherSiteWorker}/competencies`, "POST", { competency_id: compId, valid_from: today() }))
        .status,
    ).toBe(404);
    expect((await call("hseo", `/workers/${otherSiteWorker}/competencies`)).status).toBe(404);
  });

  it("pekerja (SELF): mencatat dan melihat kompetensinya sendiri, tidak milik orang lain, tidak memverifikasi", async () => {
    const lst = await call("pekerja1", "/competencies");
    expect(lst.status).toBe(200);
    const fileId = await cleanFile("pekerja1");
    const mine = await call("pekerja1", `/workers/${selfWorkerId}/competencies`, "POST", {
      competency_id: compId,
      valid_from: today(),
      source: "TRAINING",
      certificates: [{ issue_date: today(), file_id: fileId }],
    });
    expect(mine.status).toBe(201);
    expect(mine.body.data.verification_status).toBe("PENDING");
    expect((await call("pekerja1", `/workers/${selfWorkerId}/competencies`)).body.data.length).toBeGreaterThan(0);
    expect((await call("pekerja1", `/workers/${workerId}/competencies`)).status).toBe(404);
    expect(
      (await call("pekerja1", `/worker-competencies/${mine.body.data.id}/verify`, "POST", {}, { "If-Match": '"1"' })).status,
    ).toBe(403);
    expect((await call("pekerja1", "/competencies/pending-verification")).status).toBe(403);
    expect((await call("pekerja1", "/competencies", "POST", { name: "X", code: "CMP-X1" })).status).toBe(403);
    // Supervisor Team tidak dapat mencatat (tanpa competency.update)
    expect(
      (await call("spv1", `/workers/${workerId}/competencies`, "POST", { competency_id: compId, valid_from: today() })).status,
    ).toBe(403);
  });
});

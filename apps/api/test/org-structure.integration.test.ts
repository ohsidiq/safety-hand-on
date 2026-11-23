import { createPool, type Db } from "@soh/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/create-app.js";
import { makeIssuer } from "./jwt-helper.js";

/** Uji integrasi API struktur organisasi (API-002 §3-§10, ORG-API-001..010). Butuh DATABASE_URL (scripts/test-db.sh). */
const url = process.env.DATABASE_URL;

describe.skipIf(!url)("Struktur organisasi API-002 (integrasi)", () => {
  let db: Db;
  let issuer: Awaited<ReturnType<typeof makeIssuer>>;
  let app: ReturnType<typeof createApp>;
  const u: Record<string, string> = {};
  let orgA: string;
  let site1: string;
  let site2: string;
  const tag = Math.random().toString(36).slice(2, 7).toUpperCase();

  const call = async (userId: string, path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await issuer.sign({ sub: userId })}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const parsed = (await res.json().catch(() => ({}))) as {
      // biome-ignore lint/suspicious/noExplicitAny: bentuk data berbeda per endpoint; diperiksa lewat expect
      data?: any;
      error?: {
        code: string;
        details?: { field?: string; issue: string }[];
        current_version?: number;
        affected_workers?: number;
      };
    };
    return { status: res.status, body: parsed, etag: res.headers.get("etag") };
  };
  const admin = (path: string, method = "GET", body?: unknown, headers?: Record<string, string>) =>
    call(u.admin as string, path, method, body, headers);

  beforeAll(async () => {
    db = createPool(url);
    issuer = await makeIssuer();
    app = createApp({ db, auth: issuer.verifier });
    const orgs = await db.query<{ id: string }>("select id from organization order by name");
    orgA = orgs.rows[0]?.id as string;
    const orgB = orgs.rows[1]?.id as string;
    for (const [key, org, who] of [
      ["admin", orgA, "admin"],
      ["spv1", orgA, "spv1"],
      ["hsemgr", orgA, "hsemgr"],
      ["pekerja1", orgA, "pekerja1"],
      ["adminB", orgB, "admin"],
    ] as const) {
      const r = await db.query<{ id: string }>("select id from user_profile where organization_id = $1 and email like $2", [
        org,
        `${who}@%`,
      ]);
      u[key] = r.rows[0]?.id as string;
    }
    site1 = (await db.query<{ id: string }>("select id from site where organization_id = $1 and code = 'SITE-1'", [orgA])).rows[0]
      ?.id as string;
    site2 = (await db.query<{ id: string }>("select id from site where organization_id = $1 and code = 'SITE-2'", [orgA])).rows[0]
      ?.id as string;
  });

  afterAll(async () => {
    await db?.end();
  });

  it("organisasi pemanggil dari token, dengan ETag versi; tanpa organization.read -> 403", async () => {
    const r = await admin("/organization");
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ id: orgA, status: "ACTIVE" });
    expect(r.etag).toBe(`"${r.body.data?.version}"`);
    expect((await call(u.pekerja1 as string, "/organization")).status).toBe(403);
    expect((await call(u.pekerja1 as string, "/sites")).status).toBe(403);
  });

  it("scope Site: Supervisor hanya melihat Site-nya; Site lain dan tenant lain -> 404 (ORG-API-007)", async () => {
    const spv = await call(u.spv1 as string, "/sites");
    expect(spv.status).toBe(200);
    const ids = (spv.body.data as unknown as { id: string }[]).map((s) => s.id);
    expect(ids).toEqual([site1]);
    expect((await call(u.spv1 as string, `/sites/${site2}`)).status).toBe(404);
    expect((await call(u.spv1 as string, `/sites/${site2}/departments`)).status).toBe(404);
    expect((await call(u.adminB as string, `/sites/${site1}`)).status).toBe(404);
    const all = await call(u.hsemgr as string, "/sites?status=ACTIVE");
    const allIds = (all.body.data as { id: string }[]).map((s) => s.id);
    expect(allIds).toEqual(expect.arrayContaining([site1, site2]));
    expect(all.body.data.every((s: { status: string }) => s.status === "ACTIVE")).toBe(true);
  });

  it("membuat Site: timezone bawaan organisasi, kode unik, zona IANA dan format kode divalidasi; tanpa manage -> 403", async () => {
    const created = await admin("/sites", "POST", { name: "Site Uji", code: `UJI-${tag}`, location: "Kalimantan" });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ code: `UJI-${tag}`, timezone: "Asia/Jakarta", status: "ACTIVE", version: 1 });
    const dup = await admin("/sites", "POST", { name: "Site Uji 2", code: `UJI-${tag}`, timezone: "Asia/Makassar" });
    expect(dup.status).toBe(409);
    expect(dup.body.error?.code).toBe("DUPLICATE");
    const tz = await admin("/sites", "POST", { name: "Site Zona", code: `TZ-${tag}`, timezone: "Asia/Bukan" });
    expect(tz.status).toBe(422);
    expect(tz.body.error?.details?.[0]?.field).toBe("timezone");
    expect((await admin("/sites", "POST", { name: "Site Kode", code: "huruf kecil" })).status).toBe(422);
    expect((await admin("/sites", "POST", { name: "X", code: `N-${tag}` })).status).toBe(422);
    const spv = await call(u.spv1 as string, "/sites", "POST", { name: "Site Spv", code: `SPV-${tag}` });
    expect(spv.status).toBe(403);
    expect(spv.body.error?.code).toBe("FORBIDDEN");
  });

  it("PATCH wajib If-Match; versi lama -> 412 dengan current_version; berhasil menaikkan versi dan tercatat di audit", async () => {
    const s = (await admin("/sites", "POST", { name: "Site Versi", code: `VER-${tag}`, timezone: "Asia/Makassar" })).body
      .data as {
      id: string;
    };
    expect((await admin(`/sites/${s.id}`, "PATCH", { name: "Tanpa versi" })).status).toBe(422);
    expect((await admin(`/sites/${s.id}`, "PATCH", { name: "Versi rusak" }, { "If-Match": "abc" })).status).toBe(422);
    const stale = await admin(`/sites/${s.id}`, "PATCH", { name: "Versi lama" }, { "If-Match": '"7"' });
    expect(stale.status).toBe(412);
    expect(stale.body.error?.current_version).toBe(1);
    const okRes = await admin(
      `/sites/${s.id}`,
      "PATCH",
      { name: "Site Versi Baru", timezone: "Asia/Jayapura" },
      { "If-Match": '"1"' },
    );
    expect(okRes.status).toBe(200);
    expect(okRes.body.data).toMatchObject({ name: "Site Versi Baru", timezone: "Asia/Jayapura", version: 2 });
    expect(okRes.etag).toBe('"2"');
    const audit = await db.query<{ n: number }>(
      `select count(*)::int as n from audit_outbox where payload->>'entity_id' = $1 and payload->>'action' = 'site.update'
         and payload->'changed_fields' ? 'timezone' and not (payload->'changed_fields' ? 'version')`,
      [s.id],
    );
    expect(audit.rows[0]?.n).toBe(1);
  });

  it("department, division, team berjenjang; department Site lain pada team ditolak", async () => {
    const s = (await admin("/sites", "POST", { name: "Site Jenjang", code: `JEN-${tag}` })).body.data as { id: string };
    const dep = await admin(`/sites/${s.id}/departments`, "POST", { name: "Produksi", code: "PROD" });
    expect(dep.status).toBe(201);
    const depId = (dep.body.data as { id: string }).id;
    expect(dep.body.data).toMatchObject({ site_id: s.id });
    const div = await admin(`/departments/${depId}/divisions`, "POST", { name: "Hauling", code: "HAUL" });
    expect(div.status).toBe(201);
    expect(div.body.data).toMatchObject({ site_id: s.id, department_id: depId });
    const team = await admin(`/sites/${s.id}/teams`, "POST", { name: "Tim Hauling A", code: "HAUL-A", department_id: depId });
    expect(team.status).toBe(201);
    const otherDep = (await db.query<{ id: string }>("select id from department where site_id = $1 limit 1", [site1])).rows[0]
      ?.id;
    const bad = await admin(`/sites/${s.id}/teams`, "POST", { name: "Tim Salah", code: "SALAH", department_id: otherDep });
    expect(bad.status).toBe(422);
    const listed = await admin(`/sites/${s.id}/departments`);
    expect((listed.body.data as unknown as { code: string }[]).map((d) => d.code)).toEqual(["PROD"]);
    expect((await admin(`/sites/${crypto.randomUUID()}/departments`)).status).toBe(404);
  });

  it("struktur berpekerja aktif tidak dapat dinonaktifkan (ORG-API-004); yang kosong dapat dinonaktifkan dan diaktifkan kembali", async () => {
    const busy = await admin(`/sites/${site1}/deactivate`, "POST");
    expect(busy.status).toBe(409);
    expect(busy.body.error?.details?.[0]?.issue).toBe("ACTIVE_WORKERS_EXIST");
    expect(busy.body.error).toMatchObject({ affected_workers: expect.any(Number) });
    expect((busy.body.error as { affected_workers: number }).affected_workers).toBeGreaterThan(0);
    const pos = await db.query<{ id: string }>(
      "select job_position_id as id from worker where organization_id = $1 and worker_status = 'ACTIVE' limit 1",
      [orgA],
    );
    const inUse = await admin(`/job-positions/${pos.rows[0]?.id}/deactivate`, "POST");
    expect(inUse.status).toBe(409);
    expect(inUse.body.error?.details?.[0]?.issue).toBe("POSITION_IN_USE");

    const s = (await admin("/sites", "POST", { name: "Site Kosong", code: `KOS-${tag}` })).body.data as { id: string };
    const off = await admin(`/sites/${s.id}/deactivate`, "POST", undefined, { "If-Match": "1" });
    expect(off.status).toBe(200);
    expect(off.body.data).toMatchObject({ status: "INACTIVE", version: 2 });
    expect((await admin(`/sites/${s.id}/deactivate`, "POST")).status).toBe(409);
    expect((await admin(`/sites?status=INACTIVE`)).body.data?.some((x: { id: string }) => x.id === s.id)).toBe(true);
    const on = await admin(`/sites/${s.id}/reactivate`, "POST");
    expect(on.status).toBe(200);
    expect(on.body.data).toMatchObject({ status: "ACTIVE", version: 3 });
  });

  it("Job Position dan Equipment Class di level organisasi; Supervisor dapat membaca, tidak dapat mengubah", async () => {
    const jp = await admin("/job-positions", "POST", { name: "Operator HD785", code: `OP-${tag}`, job_family: "Operator" });
    expect(jp.status).toBe(201);
    const id = (jp.body.data as { id: string }).id;
    expect((await call(u.spv1 as string, `/job-positions/${id}`)).status).toBe(200);
    expect((await call(u.spv1 as string, `/job-positions/${id}`, "PATCH", { name: "Ubah" }, { "If-Match": "1" })).status).toBe(
      403,
    );
    const patched = await admin(`/job-positions/${id}`, "PATCH", { description: "Hauling" }, { "If-Match": "1" });
    expect(patched.body.data).toMatchObject({ description: "Hauling", job_family: "Operator", version: 2 });
    expect((await admin(`/job-positions/${id}/deactivate`, "POST")).status).toBe(200);
    const ec = await admin("/equipment-classes", "POST", { name: "Dump Truck", code: `DT-${tag}` });
    expect(ec.status).toBe(201);
    expect((await admin("/equipment-classes")).body.data?.some((x: { code: string }) => x.code === `DT-${tag}`)).toBe(true);
  });

  it("anggota team bertanggal: tambah, tumpang tindih ditolak, pekerja Site lain ditolak, akhiri keanggotaan", async () => {
    const team = (await admin(`/sites/${site1}/teams`, "POST", { name: "Tim Anggota", code: `ANG-${tag}` })).body.data as {
      id: string;
    };
    const w1 = (
      await db.query<{ id: string }>("select id from worker where site_id = $1 and worker_status = 'ACTIVE' limit 1", [site1])
    ).rows[0]?.id as string;
    const w2 = (await db.query<{ id: string }>("select id from worker where site_id = $1 limit 1", [site2])).rows[0]
      ?.id as string;
    const add = await admin(`/teams/${team.id}/members`, "POST", { worker_id: w1, valid_from: "2026-01-01" });
    expect(add.status).toBe(201);
    expect(add.body.data).toMatchObject({ worker_id: w1, valid_from: "2026-01-01", valid_until: null, active: true });
    expect(typeof (add.body.data as { full_name: unknown }).full_name).toBe("string");
    const overlap = await admin(`/teams/${team.id}/members`, "POST", { worker_id: w1, valid_from: "2026-06-01" });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error?.details?.[0]?.issue).toBe("MEMBERSHIP_OVERLAP");
    const mismatch = await admin(`/teams/${team.id}/members`, "POST", { worker_id: w2, valid_from: "2026-01-01" });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error?.details?.[0]?.issue).toBe("WORKER_SITE_MISMATCH");
    // team beranggota aktif tidak dapat dinonaktifkan
    expect((await admin(`/teams/${team.id}/deactivate`, "POST")).body.error?.details?.[0]?.issue).toBe("ACTIVE_MEMBERS_EXIST");
    const early = await admin(`/teams/${team.id}/members/${w1}/end`, "POST", { valid_until: "2025-12-31" });
    expect(early.status).toBe(422);
    const end = await admin(`/teams/${team.id}/members/${w1}/end`, "POST", { valid_until: "2026-02-01" });
    expect(end.status).toBe(200);
    expect(end.body.data).toMatchObject({ valid_until: "2026-02-01", active: false });
    expect((await admin(`/teams/${team.id}/members`)).body.data).toEqual([]);
    expect((await admin(`/teams/${team.id}/members?include_ended=true`)).body.data?.length).toBe(1);
    expect((await admin(`/teams/${team.id}/members/${w1}/end`, "POST", { valid_until: "2026-03-01" })).status).toBe(404);
    expect((await admin(`/teams/${team.id}/deactivate`, "POST")).status).toBe(200);
    expect((await admin(`/teams/${team.id}/members`, "POST", { worker_id: w1, valid_from: "2026-05-01" })).status).toBe(409);
    const audit = await db.query<{ action: string }>(
      "select payload->>'action' as action from audit_outbox where payload->>'entity_type' = 'team_member' order by created_at",
    );
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["team.member_add", "team.member_end"]));
  });
});

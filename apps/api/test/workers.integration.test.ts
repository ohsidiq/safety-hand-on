import { randomBytes } from "node:crypto";
import { createPool, type Db } from "@soh/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/create-app.js";
import { createNationalIdCrypto } from "../src/national-id.js";
import { makeIssuer } from "./jwt-helper.js";

/** Uji integrasi API pekerja (API-003 §2-§4, §7-§10; B-18, B-23, ER-012/013). Butuh DATABASE_URL (scripts/test-db.sh). */
const url = process.env.DATABASE_URL;

type Res = {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: bentuk data berbeda per endpoint; diperiksa lewat expect
  body: { data?: any; pagination?: { next_cursor: string | null; has_more: boolean }; error?: any };
  etag: string | null;
  text: string;
};

describe.skipIf(!url)("Pekerja API-003 (integrasi)", () => {
  let db: Db;
  let issuer: Awaited<ReturnType<typeof makeIssuer>>;
  let app: ReturnType<typeof createApp>;
  let appNoKeys: ReturnType<typeof createApp>;
  const crypto = createNationalIdCrypto(randomBytes(32), randomBytes(32));
  const u: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const tag = Math.random().toString(36).slice(2, 7).toUpperCase();
  let seq = 0;
  const empNo = () => `UJI-${tag}-${++seq}`;
  const nik = () => `3171${String(Date.now()).slice(-8)}${String(++seq).padStart(4, "0")}`.slice(0, 16);

  const call = async (
    who: string,
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
    a = app,
  ) => {
    const res = await a.request(`/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await issuer.sign({ sub: u[who] as string })}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: Res["body"] = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {};
    }
    return { status: res.status, body: parsed, etag: res.headers.get("etag"), text } as Res;
  };
  const base = () => ({
    employee_number: empNo(),
    full_name: "Pekerja Uji API",
    employment_status: "PERMANENT",
    join_date: "2026-01-05",
    site_id: ids.site1,
    department_id: ids.dep1,
    job_position_id: ids.pos,
  });

  beforeAll(async () => {
    db = createPool(url);
    issuer = await makeIssuer();
    app = createApp({ db, auth: issuer.verifier, nationalId: crypto });
    appNoKeys = createApp({ db, auth: issuer.verifier });
    const orgs = await db.query<{ id: string }>("select id from organization order by name");
    ids.orgA = orgs.rows[0]?.id as string;
    ids.orgB = orgs.rows[1]?.id as string;
    for (const who of ["admin", "spv1", "spvtim1", "hseo1", "pekerja1", "hsemgr"]) {
      const r = await db.query<{ id: string }>("select id from user_profile where organization_id = $1 and email like $2", [
        ids.orgA,
        `${who}@%`,
      ]);
      u[who] = r.rows[0]?.id as string;
    }
    const q = async (sql: string, p: unknown[] = []) => (await db.query<{ id: string }>(sql, p)).rows[0]?.id as string;
    ids.site1 = await q("select scope_id as id from user_role_assignment where user_id = $1 and scope_type = 'SITE'", [u.spv1]);
    // Site lain yang punya pekerja dan department aktif (uji lain dapat membuat Site kosong)
    ids.site2 = await q(
      `select s.id from site s where s.organization_id = $1 and s.id <> $2 and s.status = 'ACTIVE'
         and exists (select 1 from worker w where w.site_id = s.id)
         and exists (select 1 from department d where d.site_id = s.id and d.status = 'ACTIVE')
       order by s.code limit 1`,
      [ids.orgA, ids.site1],
    );
    ids.dep1 = await q("select id from department where site_id = $1 and status = 'ACTIVE' order by code limit 1", [ids.site1]);
    ids.dep2 = await q("select id from department where site_id = $1 and status = 'ACTIVE' order by code limit 1", [ids.site2]);
    ids.pos = await q("select id from job_position where organization_id = $1 and status = 'ACTIVE' order by code limit 1", [
      ids.orgA,
    ]);
    ids.ktr = await q("select id from contractor where organization_id = $1 and code = 'KTR-A'", [ids.orgA]);
    ids.wSite2 = await q("select id from worker where site_id = $1 limit 1", [ids.site2]);
  });

  afterAll(async () => {
    await db?.end();
  });

  it("daftar dengan kursor, scope Site dan Tim; di luar scope 404; pekerja hanya melihat dirinya lewat /workers/me", async () => {
    const p1 = await call("admin", "/workers?limit=5");
    expect(p1.status).toBe(200);
    expect(p1.body.data).toHaveLength(5);
    expect(p1.body.data[0]).not.toHaveProperty("phone");
    const p2 = await call("admin", `/workers?limit=5&cursor=${p1.body.pagination?.next_cursor}`);
    expect(p2.body.data[0].full_name >= p1.body.data[4].full_name).toBe(true);
    expect(p2.body.data.some((w: { id: string }) => p1.body.data.some((x: { id: string }) => x.id === w.id))).toBe(false);

    const spv = await call("spv1", "/workers?limit=100");
    expect(spv.body.data.length).toBeGreaterThan(0);
    expect(spv.body.data.every((w: { site: { id: string } }) => w.site.id === ids.site1)).toBe(true);
    expect((await call("spv1", `/workers/${ids.wSite2}`)).status).toBe(404);

    const team = await call("spvtim1", "/workers?limit=100");
    const members = await db.query<{ worker_id: string }>(
      `select tm.worker_id from team_member tm join team t on t.id = tm.team_id
       join user_role_assignment ura on ura.scope_id = t.id and ura.user_id = $1 and ura.revoked_at is null
       where tm.valid_from <= current_date and (tm.valid_until is null or tm.valid_until >= current_date)`,
      [u.spvtim1],
    );
    expect(team.body.data.map((w: { id: string }) => w.id).sort()).toEqual(members.rows.map((r) => r.worker_id).sort());

    expect((await call("pekerja1", "/workers")).status).toBe(403);
    const me = await call("pekerja1", "/workers/me");
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ has_account: true });
    expect((await call("hsemgr", "/workers/me")).status).toBe(404);
    expect((await call("admin", "/workers?cursor=rusak")).status).toBe(422);
    const found = await call("admin", `/workers?q=${encodeURIComponent(me.body.data.sho_id)}`);
    expect(found.body.data.map((w: { id: string }) => w.id)).toEqual([me.body.data.id]);
  });

  it("membuat pekerja: SHO ID dibuat sistem, penempatan awal, nomor unik; NIK hanya-tulis, tersandi, unik", async () => {
    const created = await call("admin", "/workers", "POST", base());
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ worker_status: "ACTIVE", version: 1, has_national_id: false, has_account: false });
    expect(created.body.data.sho_id).toMatch(/^SHO-[A-Z0-9-]+-\d{6}$/);
    expect(created.body.data.site).toMatchObject({ id: ids.site1 });
    const hist = await call("admin", `/workers/${created.body.data.id}/assignments`);
    expect(hist.body.data).toHaveLength(1);
    expect(hist.body.data[0]).toMatchObject({ current: true, reason: "INITIAL" });

    const dup = await call("admin", "/workers", "POST", { ...base(), employee_number: created.body.data.employee_number });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details[0].field).toBe("employee_number");
    const check = await call("admin", `/workers/duplicate-check?employee_number=${created.body.data.employee_number}`);
    expect(check.body.data).toEqual({ exists: true });
    expect((await call("admin", `/workers/duplicate-check?employee_number=TIDAK-${tag}`)).body.data).toEqual({ exists: false });

    const value = nik();
    const withNik = await call("admin", "/workers", "POST", { ...base(), national_id: value });
    expect(withNik.status).toBe(201);
    expect(withNik.body.data.has_national_id).toBe(true);
    expect(withNik.text).not.toContain(value);
    expect(withNik.text).not.toMatch(/national_id_(encrypted|hash)/);
    const stored = await db.query<{ e: Buffer; organization_id: string }>(
      "select national_id_encrypted as e, organization_id from worker where id = $1",
      [withNik.body.data.id],
    );
    expect(stored.rows[0]?.e.toString("utf8")).not.toContain(value);
    expect(crypto.open(stored.rows[0]?.organization_id as string, stored.rows[0]?.e as Buffer)).toBe(value);
    const audit = await db.query<{ p: string }>("select payload::text as p from audit_outbox where payload->>'entity_id' = $1", [
      withNik.body.data.id,
    ]);
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows.every((r) => !r.p.includes(value))).toBe(true);
    expect(audit.rows.some((r) => r.p.includes('"national_id"'))).toBe(true);

    const dupNik = await call("admin", "/workers", "POST", { ...base(), national_id: value });
    expect(dupNik.status).toBe(409);
    expect(dupNik.body.error.details[0].field).toBe("national_id");
    expect((await call("admin", "/workers", "POST", { ...base(), national_id: "123" })).status).toBe(422);
    expect((await call("admin", "/workers", "POST", { ...base(), national_id: nik() }, {}, appNoKeys)).status).toBe(503);
  });

  it("aturan kontraktor (ER-012/013), department harus milik Site, tanggal masuk, tanpa permission", async () => {
    const need = await call("admin", "/workers", "POST", { ...base(), employment_status: "CONTRACTOR" });
    expect(need.body.error.code).toBe("CONTRACTOR_REQUIRED");
    const notAllowed = await call("admin", "/workers", "POST", { ...base(), contractor_id: ids.ktr });
    expect(notAllowed.body.error.code).toBe("CONTRACTOR_NOT_ALLOWED");
    const site = await call("admin", "/workers", "POST", {
      ...base(),
      employment_status: "CONTRACTOR",
      contractor_id: ids.ktr,
      site_id: ids.site2,
      department_id: ids.dep2,
    });
    expect(site.status).toBe(422);
    expect(site.body.error.code).toBe("SITE_NOT_LINKED_TO_CONTRACTOR");
    const okCtr = await call("admin", "/workers", "POST", { ...base(), employment_status: "CONTRACTOR", contractor_id: ids.ktr });
    expect(okCtr.status).toBe(201);
    expect(okCtr.body.data.contractor).toMatchObject({ id: ids.ktr });
    const dep = await call("admin", "/workers", "POST", { ...base(), department_id: ids.dep2 });
    expect(dep.body.error.code).toBe("DEPARTMENT_NOT_IN_SITE");
    expect((await call("admin", "/workers", "POST", { ...base(), join_date: "2099-01-01" })).status).toBe(422);
    expect((await call("spv1", "/workers", "POST", base())).status).toBe(403);
    // ubah status kerja dari CONTRACTOR melepas kontraktor
    const patched = await call(
      "admin",
      `/workers/${okCtr.body.data.id}`,
      "PATCH",
      { employment_status: "CONTRACT" },
      { "If-Match": '"1"' },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({ employment_status: "CONTRACT", contractor: null, version: 2 });
  });

  it("PATCH wajib If-Match; versi lama 412; status lewat aksi beralasan dengan transisi yang sah", async () => {
    const w = (await call("admin", "/workers", "POST", base())).body.data;
    expect((await call("admin", `/workers/${w.id}`, "PATCH", { full_name: "Tanpa versi" })).status).toBe(422);
    const stale = await call("admin", `/workers/${w.id}`, "PATCH", { full_name: "Lama" }, { "If-Match": "9" });
    expect(stale.status).toBe(412);
    expect(stale.body.error.current_version).toBe(1);
    const ok = await call(
      "admin",
      `/workers/${w.id}`,
      "PATCH",
      { full_name: "Pekerja Diubah", phone: "+6281234567890" },
      { "If-Match": '"1"' },
    );
    expect(ok.body.data).toMatchObject({ full_name: "Pekerja Diubah", phone: "+6281234567890", version: 2 });
    expect(ok.etag).toBe('"2"');

    expect((await call("admin", `/workers/${w.id}/suspend`, "POST", {})).body.error.code).toBe("REASON_REQUIRED");
    expect((await call("hseo1", `/workers/${w.id}/suspend`, "POST", { reason: "Uji izin" })).status).toBe(403);
    const sus = await call("admin", `/workers/${w.id}/suspend`, "POST", { reason: "Skorsing uji" });
    expect(sus.body.data.worker_status).toBe("SUSPENDED");
    expect((await call("admin", `/workers/${w.id}/suspend`, "POST", { reason: "Lagi" })).body.error.code).toBe(
      "INVALID_STATE_TRANSITION",
    );
    expect(
      (await call("admin", `/workers/${w.id}/reinstate`, "POST", { reason: "Selesai skorsing" })).body.data.worker_status,
    ).toBe("ACTIVE");
    expect((await call("admin", `/workers/${w.id}/resign`, "POST", { reason: "Mengundurkan diri" })).status).toBe(422);
    const res = await call("admin", `/workers/${w.id}/resign`, "POST", { reason: "Mengundurkan diri", exit_date: "2026-03-01" });
    expect(res.body.data).toMatchObject({ worker_status: "RESIGNED", exit_date: "2026-03-01" });
    expect((await call("admin", `/workers/${w.id}/reactivate`, "POST", { reason: "x yz" })).body.error.code).toBe(
      "INVALID_STATE_TRANSITION",
    );
    const after = await call(
      "admin",
      `/workers/${w.id}`,
      "PATCH",
      { full_name: "Tidak boleh" },
      { "If-Match": `"${res.body.data.version}"` },
    );
    expect(after.body.error.code).toBe("INVALID_STATE_TRANSITION");
    const audit = await db.query<{ reason: string; perm: string }>(
      `select payload->'changes'->>'reason' as reason, payload->>'actor_role_code' as perm from audit_outbox
       where payload->>'entity_id' = $1 and payload->>'action' = 'worker.suspend'`,
      [w.id],
    );
    expect(audit.rows[0]?.reason).toBe("Skorsing uji");
  });

  it("penempatan berriwayat: mutasi Site, alasan wajib, tanggal mendatang ditolak, tumpang tindih, scope asal", async () => {
    const w = (await call("admin", "/workers", "POST", { ...base(), join_date: "2026-01-01" })).body.data;
    const body = { site_id: ids.site2, department_id: ids.dep2, job_position_id: ids.pos, effective_from: "2026-02-01" };
    expect((await call("admin", `/workers/${w.id}/assignments`, "POST", body)).body.error.code).toBe("REASON_REQUIRED");
    const future = await call("admin", `/workers/${w.id}/assignments`, "POST", {
      ...body,
      effective_from: "2099-01-01",
      reason: "Mutasi",
    });
    expect(future.status).toBe(422);
    const dep = await call("admin", `/workers/${w.id}/assignments`, "POST", {
      ...body,
      department_id: ids.dep1,
      reason: "Mutasi",
    });
    expect(dep.body.error.code).toBe("DEPARTMENT_NOT_IN_SITE");
    expect((await call("spv1", `/workers/${w.id}/assignments`, "POST", { ...body, reason: "Mutasi" })).status).toBe(403);
    const moved = await call("admin", `/workers/${w.id}/assignments`, "POST", { ...body, reason: "Mutasi ke Site lain" });
    expect(moved.status).toBe(201);
    expect(moved.body.data.site).toMatchObject({ id: ids.site2 });
    const hist = (await call("admin", `/workers/${w.id}/assignments`)).body.data;
    expect(hist).toHaveLength(2);
    expect(hist[0]).toMatchObject({ current: true, effective_from: "2026-02-01", reason: "Mutasi ke Site lain" });
    expect(hist[1]).toMatchObject({ current: false, effective_until: "2026-01-31" });
    const overlap = await call("admin", `/workers/${w.id}/assignments`, "POST", {
      ...body,
      effective_from: "2026-01-15",
      reason: "Mundur",
    });
    expect(overlap.body.error.code).toBe("ASSIGNMENT_OVERLAP");
    // Supervisor Site asal tidak lagi melihat pekerja yang dimutasi
    expect((await call("spv1", `/workers/${w.id}`)).status).toBe(404);
  });

  it("kontraktor untuk pemilih: Site terhubung; tanpa contractor.read 403", async () => {
    const r = await call("admin", "/contractors?status=ACTIVE");
    expect(r.status).toBe(200);
    const ktr = r.body.data.find((c: { id: string }) => c.id === ids.ktr);
    expect(ktr).toMatchObject({ code: "KTR-A", site_ids: [ids.site1] });
    expect((await call("spv1", "/contractors")).status).toBe(403);
  });
});

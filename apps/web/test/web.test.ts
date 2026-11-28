import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "../app/manifest";
import { apiUrl, fetchApiStatus } from "../lib/api";

describe("PWA manifest", () => {
  it("memenuhi syarat dapat dipasang (nama, start_url, standalone, ikon 192 dan 512)", () => {
    const m = manifest();
    expect(m.name).toBe("Safety On Hand");
    expect(m.start_url).toBe("/");
    expect(m.display).toBe("standalone");
    const sizes = (m.icons ?? []).map((i) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  });
});

describe("klien Core API", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("membentuk URL /api/v1 tanpa garis miring ganda", () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://api.contoh/");
    expect(apiUrl("/health/live")).toBe("https://api.contoh/api/v1/health/live");
  });

  it("UNKNOWN bila alamat API belum diatur", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "");
    expect(await fetchApiStatus()).toBe("UNKNOWN");
  });

  it("UP bila health/live menjawab UP, DOWN bila jaringan gagal", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://api.contoh");
    const ok = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { status: "UP" } })));
    expect(await fetchApiStatus(ok as unknown as typeof fetch)).toBe("UP");
    const fail = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await fetchApiStatus(fail as unknown as typeof fetch)).toBe("DOWN");
  });
});

import { urlBase64ToUint8Array } from "../lib/push";

describe("urlBase64ToUint8Array", () => {
  it("mengubah base64url (tanpa padding) ke byte", () => {
    expect(Array.from(urlBase64ToUint8Array("AQID_-8"))).toEqual([1, 2, 3, 255, 239]);
  });
});

describe("login dan /auth/me", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pesan galat login tidak membedakan akun tidak ada dan kata sandi salah", async () => {
    const { loginErrorMessage } = await import("../lib/supabase");
    expect(loginErrorMessage({ status: 400, code: "invalid_credentials" })).toBe("Email atau kata sandi salah.");
    expect(loginErrorMessage({ status: 400, code: "user_not_found" })).toBe("Email atau kata sandi salah.");
    expect(loginErrorMessage({ status: 429 })).toMatch(/Terlalu banyak/);
  });

  it("tanpa konfigurasi Supabase, klien login tidak dibuat", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.resetModules();
    const { getSupabase } = await import("../lib/supabase");
    expect(getSupabase()).toBeNull();
  });

  it("fetchMe mengirim token Bearer dan memetakan galat API", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://api.contoh");
    const { fetchMe } = await import("../lib/api");
    const calls: [string, RequestInit | undefined][] = [];
    const reply = (status: number, body: unknown) =>
      (async (url: string, init?: RequestInit) => {
        calls.push([url, init]);
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch;

    const ok = await fetchMe("tok", reply(200, { success: true, data: { user_id: "u" } }));
    expect(ok).toMatchObject({ ok: true, me: { user_id: "u" } });
    expect(calls[0]?.[0]).toBe("https://api.contoh/api/v1/auth/me");
    expect((calls[0]?.[1]?.headers as Record<string, string> | undefined)?.Authorization).toBe("Bearer tok");

    expect(await fetchMe("t", reply(401, { error: { code: "UNAUTHORIZED" } }))).toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect(await fetchMe("t", reply(403, { error: { code: "ACCOUNT_DEACTIVATED" } }))).toEqual({
      ok: false,
      code: "ACCOUNT_DEACTIVATED",
    });
    expect(await fetchMe("t", reply(500, { error: { code: "INTERNAL_ERROR" } }))).toEqual({ ok: false, code: "UNAVAILABLE" });
  });
});

describe("menu per peran (UIUX-002 §5, IA-006, IA-008)", () => {
  it("Company Admin melihat Beranda, Jejak Audit, Profil; menu yang belum dibangun tidak tampil", async () => {
    const { visibleNav } = await import("../lib/nav");
    const hrefs = visibleNav(["user.manage", "audit.view", "worker.read", "dashboard.view"]).map((i) => i.href);
    expect(hrefs).toEqual(["/dashboard", "/workers", "/audit", "/profile"]);
  });

  it("Supervisor (tanpa audit.view) tidak melihat Jejak Audit", async () => {
    const { visibleNav, canSee } = await import("../lib/nav");
    const perms = ["worker.read", "observation.create"];
    expect(visibleNav(perms).map((i) => i.href)).toEqual(["/dashboard", "/workers", "/profile"]);
    expect(canSee(perms, "/audit")).toBe(false);
  });

  it("item fase yang belum dirilis tidak tampil walau permission ada", async () => {
    const { visibleNav } = await import("../lib/nav");
    const items = [
      { href: "/x", label: "X", domain: "Readiness" as const, anyOf: ["a"], phase: "P2" as const, built: true },
      { href: "/y", label: "Y", domain: "Platform" as const, anyOf: ["a"], phase: "P0" as const, built: true },
    ];
    expect(visibleNav(["a"], items).map((i) => i.href)).toEqual(["/y"]);
  });
});

describe("Jejak Audit di web", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rentang tanggal menjadi [from, to) UTC; terbalik atau lebih dari 92 hari ditolak", async () => {
    const { rangeFromDates } = await import("../lib/audit-range");
    const r = rangeFromDates("2026-11-01", "2026-11-07");
    expect(r).not.toBeNull();
    expect(Date.parse(r?.to ?? "") - Date.parse(r?.from ?? "")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(rangeFromDates("2026-11-07", "2026-11-01")).toBeNull();
    expect(rangeFromDates("2026-01-01", "2026-06-01")).toBeNull();
    expect(rangeFromDates("bukan", "2026-11-01")).toBeNull();
  });

  it("kueri audit hanya memuat filter yang diisi", async () => {
    const { auditQuery } = await import("../lib/api");
    const q = new URLSearchParams(auditQuery({ from: "a", to: "b", action: "auth.login_success" }).split("?")[1]);
    expect(Object.fromEntries(q)).toEqual({ from: "a", to: "b", limit: "25", action: "auth.login_success" });
  });

  it("apiGet memetakan 403 menjadi kode FORBIDDEN tanpa melempar", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://api.contoh");
    const { apiGet } = await import("../lib/api");
    const fetcher = (async () =>
      new Response(JSON.stringify({ success: false, error: { code: "FORBIDDEN" } }), { status: 403 })) as unknown as typeof fetch;
    expect(await apiGet("/audit-logs", "t", fetcher)).toEqual({ ok: false, status: 403, code: "FORBIDDEN" });
  });
});

describe("notifikasi di web", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("menu Notifikasi tampil bagi pemegang notification.read, setelah Jejak Audit", async () => {
    const { visibleNav } = await import("../lib/nav");
    expect(visibleNav(["notification.read", "audit.view"]).map((i) => i.href)).toEqual([
      "/dashboard",
      "/notifications",
      "/audit",
      "/profile",
    ]);
  });

  it("tautan notifikasi hanya rute internal", async () => {
    const { safeInternalLink } = await import("../lib/api");
    expect(safeInternalLink("/profile")).toBe("/profile");
    expect(safeInternalLink("https://evil.example")).toBeNull();
    expect(safeInternalLink("//evil.example")).toBeNull();
    expect(safeInternalLink("javascript:alert(1)")).toBeNull();
    expect(safeInternalLink(null)).toBeNull();
  });

  it("apiPost mengirim token dan badan JSON, memetakan 404 ke NOT_FOUND", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://api.contoh");
    const { apiPost } = await import("../lib/api");
    let seen: RequestInit | undefined;
    const fetcher = (async (_u: string, init?: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify({ success: false, error: { code: "NOT_FOUND" } }), { status: 404 });
    }) as unknown as typeof fetch;
    expect(await apiPost("/notifications/x/read", "tok", { a: 1 }, fetcher)).toEqual({
      ok: false,
      status: 404,
      code: "NOT_FOUND",
    });
    expect(seen?.method).toBe("POST");
    expect((seen?.headers as Record<string, string> | undefined)?.Authorization).toBe("Bearer tok");
    expect(seen?.body).toBe('{"a":1}');
  });
});

describe("Struktur Organisasi di web (UIUX-005 §3, API-002)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("menu tampil untuk pengelola struktur (organization.manage), tidak untuk Supervisor", async () => {
    const { canSee } = await import("../lib/nav");
    expect(canSee(["organization.read", "organization.manage"], "/organization")).toBe(true);
    expect(canSee(["organization.read", "worker.read"], "/organization")).toBe(false);
  });

  it("validasi nama dan kode sama dengan API-002 §10; kode dinormalkan ke huruf besar", async () => {
    const { validateNameCode, normalizeCode } = await import("../lib/org");
    expect(validateNameCode("Site A", "SITE-A")).toBeNull();
    expect(validateNameCode("A", "SITE-A")).toMatch(/Nama/);
    expect(validateNameCode("Site A", "site a")).toMatch(/Kode/);
    expect(normalizeCode("tim hauling a!")).toBe("TIM-HAULING-A");
  });

  it("pesan galat: masih dipakai pekerja menyebut jumlah, versi lama, duplikat; tanpa detail teknis", async () => {
    const { orgErrorMessage } = await import("../lib/org");
    const e = (code: string, issue?: string, extra: Record<string, unknown> = {}) => ({
      status: 409,
      code,
      details: issue ? [{ issue }] : [],
      extra,
    });
    expect(orgErrorMessage(e("CONFLICT", "ACTIVE_WORKERS_EXIST", { affected_workers: 12 }))).toContain("12 pekerja aktif");
    expect(orgErrorMessage(e("CONFLICT", "POSITION_IN_USE", { affected_workers: 3 }))).toContain("3 pekerja aktif");
    expect(orgErrorMessage(e("VERSION_CONFLICT"))).toMatch(/Muat ulang/);
    expect(orgErrorMessage(e("DUPLICATE"))).toMatch(/Kode sudah dipakai/);
    expect(
      orgErrorMessage({
        status: 422,
        code: "VALIDATION_ERROR",
        details: [{ field: "timezone", issue: "invalid_iana" }],
        extra: {},
      }),
    ).toMatch(/Zona waktu/);
  });

  it("apiSend mengirim If-Match dan mengembalikan rincian galat (details, current_version)", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://api.contoh");
    const { apiSend } = await import("../lib/api");
    const fetcher = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            success: false,
            error: { code: "VERSION_CONFLICT", message: "x", current_version: 4 },
            request_id: "r",
          }),
          { status: 412 },
        ),
    );
    const r = await apiSend(
      "PATCH",
      "/sites/1",
      "tok",
      { name: "B" },
      { ifMatch: 3, fetcher: fetcher as unknown as typeof fetch },
    );
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["If-Match"]).toBe('"3"');
    expect(init.method).toBe("PATCH");
    expect(r).toEqual({
      ok: false,
      error: { status: 412, code: "VERSION_CONFLICT", details: [], extra: { current_version: 4 } },
    });
  });
});

describe("Pekerja di web (UIUX-005 §4, API-003)", () => {
  it("aksi status sah per status; berhenti bersifat akhir", async () => {
    const { STATUS_ACTIONS } = await import("../lib/workers");
    expect(STATUS_ACTIONS.ACTIVE.map((a) => a.action)).toEqual(["suspend", "deactivate", "resign"]);
    expect(STATUS_ACTIONS.SUSPENDED.map((a) => a.action)).toContain("reinstate");
    expect(STATUS_ACTIONS.INACTIVE.map((a) => a.action)).toEqual(["reactivate", "resign"]);
    expect(STATUS_ACTIONS.RESIGNED).toEqual([]);
  });

  it("pemilih kontraktor mengikuti Site terhubung (ER-013); kontraktor tanpa relasi tidak dibatasi", async () => {
    const { contractorsForSite } = await import("../lib/workers");
    const list = [
      { id: "a", code: "A", name: "A", status: "ACTIVE" as const, site_ids: ["s1"] },
      { id: "b", code: "B", name: "B", status: "ACTIVE" as const, site_ids: [] },
      { id: "c", code: "C", name: "C", status: "INACTIVE" as const, site_ids: ["s2"] },
    ];
    expect(contractorsForSite(list, "s1").map((c) => c.id)).toEqual(["a", "b"]);
    expect(contractorsForSite(list, "s2").map((c) => c.id)).toEqual(["b"]);
  });

  it("validasi isian dan pesan galat tanpa nilai NIK", async () => {
    const { validateWorkerInput, workerErrorMessage } = await import("../lib/workers");
    expect(validateWorkerInput({ employee_number: "EMP-001", full_name: "Budi", phone: "+6281234567890" })).toBeNull();
    expect(validateWorkerInput({ phone: "0812" })).toMatch(/internasional/);
    expect(validateWorkerInput({ national_id: "123" })).toMatch(/16 digit/);
    const msg = workerErrorMessage({
      status: 409,
      code: "DUPLICATE",
      details: [{ field: "national_id", issue: "already_used" }],
      extra: {},
    });
    expect(msg).toMatch(/NIK sudah terdaftar/);
    expect(workerErrorMessage({ status: 422, code: "SITE_NOT_LINKED_TO_CONTRACTOR", details: [], extra: {} })).toMatch(
      /tidak terhubung/,
    );
    expect(
      workerErrorMessage({
        status: 503,
        code: "SERVICE_UNAVAILABLE",
        details: [{ field: "national_id", issue: "x" }],
        extra: {},
      }),
    ).toMatch(/NIK belum diaktifkan/);
  });
});

describe("Impor pekerja di web (API-003 §6)", () => {
  it("label galat impor dalam bahasa pengguna; kode tak dikenal tetap aman", async () => {
    const { importErrorLabel } = await import("../lib/workers");
    expect(importErrorLabel("SITE_NOT_LINKED_TO_CONTRACTOR")).toMatch(/tidak terhubung/);
    expect(importErrorLabel("must_be_16_digits")).toMatch(/16 digit/);
    expect(importErrorLabel("KODE_BARU")).toBe("Tidak dapat disimpan");
  });

  it("apiSend meneruskan Idempotency-Key", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://api.contoh");
    const { apiSend } = await import("../lib/api");
    const fetcher = vi.fn(
      async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ success: true, data: { ok: 1 } })),
    );
    await apiSend(
      "POST",
      "/workers/imports",
      "tok",
      {},
      { headers: { "Idempotency-Key": "k-1" }, fetcher: fetcher as unknown as typeof fetch },
    );
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("k-1");
    vi.unstubAllEnvs();
  });
});

describe("Unggah berkas privat (API-000 §14)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("validasi jenis dan ukuran di klien", async () => {
    const { checkFile } = await import("../lib/files");
    expect(checkFile({ type: "application/pdf", size: 1000 })).toBeNull();
    expect(checkFile({ type: "application/zip", size: 1000 })).toMatch(/PDF/);
    expect(checkFile({ type: "application/pdf", size: 11 * 1024 * 1024 })).toMatch(/10 MB/);
    expect(checkFile({ type: "image/png", size: 15 * 1024 * 1024 })).toBeNull();
  });

  it("tiga langkah: daftar, PUT langsung ke penyimpanan (tanpa token API), complete", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://api.contoh");
    const { uploadFile } = await import("../lib/files");
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/files"))
        return new Response(JSON.stringify({ success: true, data: { file_id: "f1", upload_url: "https://store/up?token=x" } }), {
          status: 201,
        });
      if (url.startsWith("https://store/")) return new Response("{}", { status: 200 });
      return new Response(JSON.stringify({ success: true, data: { id: "f1", scan_status: "CLEAN", scan_detail: null } }));
    });
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "a.pdf", { type: "application/pdf" });
    const r = await uploadFile("tok", file, "COMPETENCY_CERTIFICATE", fetcher as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, file: { id: "f1", scan_status: "CLEAN", scan_detail: null } });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.contoh/api/v1/files",
      "https://store/up?token=x",
      "https://api.contoh/api/v1/files/f1/complete",
    ]);
    const putInit = calls[1]?.init as RequestInit;
    const putHeaders = putInit.headers as Record<string, string>;
    expect(putHeaders.Authorization).toBeUndefined();
  });
});

describe("kompetensi (M3.2)", () => {
  it("validasi klien: kompetensi wajib, mulai tidak di masa depan, rentang tanggal, sertifikat", async () => {
    const { validateCompetencyInput } = await import("../lib/competencies");
    const base = { competency_id: "c", valid_from: "2026-11-01", valid_until: "", issue_date: "", expiry_date: "" };
    expect(validateCompetencyInput(base, "2026-11-24", false)).toBeNull();
    expect(validateCompetencyInput({ ...base, competency_id: "" }, "2026-11-24", false)).toBe("Pilih kompetensi.");
    expect(validateCompetencyInput({ ...base, valid_from: "2026-12-01" }, "2026-11-24", false)).toMatch(/masa depan/);
    expect(validateCompetencyInput({ ...base, valid_until: "2026-10-01" }, "2026-11-24", false)).toMatch(/lebih awal/);
    expect(validateCompetencyInput(base, "2026-11-24", true)).toMatch(/terbit/);
    expect(validateCompetencyInput({ ...base, issue_date: "2026-11-01", expiry_date: "2026-01-01" }, "2026-11-24", true)).toMatch(
      /kedaluwarsa/,
    );
  });

  it("masa berlaku bawaan dari master dan pesan galat pemisahan tugas", async () => {
    const { suggestUntil, competencyErrorMessage, VALIDITY_LABEL } = await import("../lib/competencies");
    expect(suggestUntil("2026-01-31", 36)).toBe("2029-01-31");
    expect(suggestUntil("2026-01-31", 1)).toBe("2026-02-28");
    expect(suggestUntil("2026-01-01", 12)).toBe("2027-01-01");
    expect(suggestUntil("2026-01-01", null)).toBe("");
    expect(competencyErrorMessage({ status: 403, code: "SEPARATION_OF_DUTIES", details: [], extra: {} })).toMatch(/orang lain/);
    expect(
      competencyErrorMessage({
        status: 422,
        code: "VALIDATION_ERROR",
        details: [{ field: "valid_from", issue: "in_future" }],
        extra: {},
      }),
    ).toMatch(/masa depan/);
    expect(VALIDITY_LABEL.EXPIRING_SOON).toBe("Segera berakhir");
  });

  it("menu Kompetensi hanya untuk pemverifikasi atau pengelola master", async () => {
    const { canSee } = await import("../lib/nav");
    expect(canSee(["competency.verify"], "/competencies")).toBe(true);
    expect(canSee(["readiness_profile.manage"], "/competencies")).toBe(true);
    expect(canSee(["competency.read", "competency.update"], "/competencies")).toBe(false);
  });
});

describe("Otorisasi Kerja (M3.3)", () => {
  it("aksi pembekuan sah per status; REVOKED tanpa aksi dan dilabeli Dicabut", async () => {
    const { suspensionActions, authStatusLabel } = await import("../lib/authorizations");
    expect(suspensionActions("NONE")).toEqual(["suspend", "revoke"]);
    expect(suspensionActions("SUSPENDED")).toEqual(["reinstate", "revoke"]);
    expect(suspensionActions("REVOKED")).toEqual([]);
    expect(authStatusLabel({ validity_status: "SUSPENDED", suspension_status: "REVOKED" })).toBe("Dicabut");
    expect(authStatusLabel({ validity_status: "SUSPENDED", suspension_status: "SUSPENDED" })).toBe("Dibekukan");
  });

  it("validasi: lingkup wajib bila jenis mensyaratkan, tanggal", async () => {
    const { validateAuthorizationInput } = await import("../lib/authorizations");
    const type = {
      id: "t",
      name: "Pekerjaan Panas",
      code: "AUTH-HOTWORK",
      description: null,
      requires_work_scope: true,
      default_validity_months: 12,
      status: "ACTIVE" as const,
      version: 1,
    };
    const base = { type, valid_from: "2026-11-01", valid_until: "", work_scope: "" };
    expect(validateAuthorizationInput(base, "2026-11-24")).toMatch(/lingkup/);
    expect(validateAuthorizationInput({ ...base, work_scope: "Las pipa" }, "2026-11-24")).toBeNull();
    expect(validateAuthorizationInput({ ...base, type: undefined }, "2026-11-24")).toBe("Pilih jenis otorisasi.");
    expect(validateAuthorizationInput({ ...base, work_scope: "x", valid_from: "2026-12-01" }, "2026-11-24")).toMatch(
      /masa depan/,
    );
  });

  it("menu Otorisasi Kerja untuk pemverifikasi atau pengelola jenis", async () => {
    const { canSee } = await import("../lib/nav");
    expect(canSee(["authorization.verify"], "/authorizations")).toBe(true);
    expect(canSee(["authorization.read", "authorization.update"], "/authorizations")).toBe(false);
  });
});

describe("SIMPER (M3.4)", () => {
  it("otorisasi kelas alat harus di dalam masa berlaku SIMPER", async () => {
    const { classAuthWithinSimper } = await import("../lib/simpers");
    const simper = { valid_from: "2026-01-01", valid_until: "2026-12-31" };
    expect(classAuthWithinSimper({ valid_from: "2026-01-01", valid_until: "2026-12-31" }, simper)).toBeNull();
    expect(classAuthWithinSimper({ valid_from: "2025-12-31", valid_until: "2026-06-01" }, simper)).toMatch(/sebelum SIMPER/);
    expect(classAuthWithinSimper({ valid_from: "2026-02-01", valid_until: "" }, simper)).toMatch(/setelah SIMPER/);
    expect(classAuthWithinSimper({ valid_from: "2026-02-01", valid_until: "" }, { ...simper, valid_until: "" })).toBeNull();
    expect(classAuthWithinSimper({ valid_from: "2026-03-01", valid_until: "2026-02-01" }, simper)).toMatch(/lebih awal/);
  });

  it("aksi status kelas alat, ringkasan kelas aktif, pesan galat khusus", async () => {
    const { classAuthActions, activeClasses, simperErrorMessage } = await import("../lib/simpers");
    expect(classAuthActions("ACTIVE")).toEqual(["suspend", "revoke"]);
    expect(classAuthActions("REVOKED")).toEqual([]);
    const auth = (name: string, status: "ACTIVE" | "SUSPENDED" | "REVOKED") => ({
      id: name,
      simper_id: "s",
      equipment_class: { id: name, name, code: name },
      valid_from: "2026-01-01",
      valid_until: null,
      restriction_note: null,
      status,
      status_reason: null,
      version: 1,
    });
    expect(activeClasses({ equipment_authorizations: [auth("Dump Truck", "ACTIVE"), auth("Excavator", "REVOKED")] })).toBe(
      "Dump Truck",
    );
    expect(activeClasses({ equipment_authorizations: [] })).toMatch(/Tidak ada/);
    expect(simperErrorMessage({ status: 422, code: "AUTHORIZATION_OUTSIDE_SIMPER_VALIDITY", details: [], extra: {} })).toMatch(
      /masa berlaku SIMPER/,
    );
    expect(
      simperErrorMessage({
        status: 409,
        code: "DUPLICATE",
        details: [{ field: "equipment_class_id", issue: "already_authorized" }],
        extra: {},
      }),
    ).toMatch(/Kelas alat ini/);
  });

  it("menu SIMPER untuk pemverifikasi atau pengelola jenis", async () => {
    const { canSee } = await import("../lib/nav");
    expect(canSee(["simper.verify"], "/simpers")).toBe(true);
    expect(canSee(["simper.read", "simper.update"], "/simpers")).toBe(false);
  });
});

describe("Medical (M3.5, B-27 Dokter)", () => {
  it("aturan penetapan Dokter: 4 hasil, pembatasan, tindak lanjut wajib, tinjau ulang opsional (B-27)", async () => {
    const { validateDetermination, FITNESS_OPTIONS } = await import("../lib/medical");
    expect(FITNESS_OPTIONS.map((o) => o.value)).toEqual(["FIT", "FIT_WITH_CONDITION", "FIT_WITH_RESTRICTION", "UNFIT"]);
    const base = {
      fitness: "" as const,
      unfit_until: "",
      follow_up_note: "",
      follow_up_due: "",
      restriction_code: "",
      restriction_until: "",
    };
    const t = "2026-11-26";
    expect(validateDetermination(base, t)).toMatch(/Pilih status/);
    expect(validateDetermination({ ...base, fitness: "FIT" }, t)).toBeNull();
    expect(validateDetermination({ ...base, fitness: "FIT_WITH_RESTRICTION" }, t)).toMatch(/pembatasan/);
    expect(
      validateDetermination({ ...base, fitness: "FIT_WITH_RESTRICTION", restriction_code: "NO_WORK_AT_HEIGHT" }, t),
    ).toBeNull();
    expect(validateDetermination({ ...base, fitness: "FIT_WITH_CONDITION" }, t)).toMatch(/tindak lanjut/);
    expect(validateDetermination({ ...base, fitness: "FIT_WITH_CONDITION", follow_up_note: "Kontrol ulang" }, t)).toMatch(
      /tanggal/,
    );
    expect(
      validateDetermination(
        { ...base, fitness: "FIT_WITH_CONDITION", follow_up_note: "Kontrol", follow_up_due: "2026-12-10" },
        t,
      ),
    ).toBeNull();
    expect(validateDetermination({ ...base, fitness: "UNFIT" }, t)).toBeNull();
    expect(validateDetermination({ ...base, fitness: "UNFIT", unfit_until: "2026-11-01" }, t)).toMatch(/lewat/);
  });

  it("pemeriksaan kesiapan: checklist lengkap untuk siap, catatan untuk tidak siap, tanpa angka tanda vital", async () => {
    const { validateClearance, CLEARANCE_CHECKLIST, medicalErrorMessage } = await import("../lib/medical");
    const all = { history_reviewed: true, blood_pressure_checked: true, vital_signs_checked: true, vitals_within_limits: true };
    const base = { clearance_type_id: "t1", result: "CLEARED" as const, checks: all, note: "" };
    expect(validateClearance(base)).toBeNull();
    expect(validateClearance({ ...base, clearance_type_id: "" })).toMatch(/jenis/);
    expect(validateClearance({ ...base, checks: { ...all, blood_pressure_checked: false } })).toMatch(/checklist/);
    expect(validateClearance({ ...base, result: "NOT_CLEARED", checks: { ...all, vitals_within_limits: false } })).toMatch(
      /catatan/,
    );
    expect(CLEARANCE_CHECKLIST.map((c) => c.label).join(" ")).not.toMatch(/\d/);
    expect(medicalErrorMessage({ status: 422, code: "RESTRICTION_CONFLICT", details: [], extra: {} })).toMatch(/pembatasan/);
  });

  it("jenis kerja khusus: validasi tambah/ubah dan pesan kode ganda", async () => {
    const { validateClearanceType } = await import("../lib/medical");
    const ok = { name: "Kerja di Ketinggian", code: "work-at-height", hours: "12", blocking: [] };
    expect(validateClearanceType(ok)).toBeNull();
    expect(validateClearanceType({ ...ok, name: "x" })).toMatch(/Nama/);
    expect(validateClearanceType({ ...ok, code: "KERJA_TINGGI" })).toMatch(/Kode/);
    expect(validateClearanceType({ ...ok, hours: "25" })).toMatch(/1-24/);
    expect(validateClearanceType({ ...ok, hours: "0" })).toMatch(/1-24/);
    const { medicalErrorMessage } = await import("../lib/medical");
    expect(medicalErrorMessage({ status: 409, code: "DUPLICATE", details: [], extra: {} })).toMatch(/Kode sudah dipakai/);
  });

  it("jenis pemeriksaan MCU: validasi tambah/ubah dan pesan master terpakai (B-28)", async () => {
    const { validateExamType, medicalErrorMessage } = await import("../lib/medical");
    const ok = { name: "MCU Berkala", code: "mcu-periodic", months: "12" };
    expect(validateExamType(ok)).toBeNull();
    expect(validateExamType({ ...ok, months: "" })).toBeNull();
    expect(validateExamType({ ...ok, name: "a" })).toMatch(/Nama/);
    expect(validateExamType({ ...ok, code: "MCU PERIODIK" })).toMatch(/Kode/);
    expect(validateExamType({ ...ok, months: "601" })).toMatch(/1-600/);
    expect(medicalErrorMessage({ status: 409, code: "MASTER_IN_USE", details: [], extra: {} })).toMatch(/Nonaktifkan/);
  });

  it("kode pembatasan hanya batasan kerja (tanpa istilah diagnosis) dan pesan galat akses", async () => {
    const { RESTRICTION_CODES, medicalErrorMessage, MEDICAL_VALIDITY_LABEL } = await import("../lib/medical");
    for (const r of RESTRICTION_CODES) {
      expect(r.code).toMatch(/^[A-Z][A-Z0-9_]{2,49}$/);
      expect(r.description).toMatch(/^(Tidak|Hanya)/);
    }
    expect(medicalErrorMessage({ status: 400, code: "ACCESS_REASON_REQUIRED", details: [], extra: {} })).toMatch(/alasan akses/);
    expect(MEDICAL_VALIDITY_LABEL.SUSPENDED).toBe("Tidak fit");
  });

  it("menu Medical hanya untuk Dokter atau pengelola jenis; Medical Officer dan Supervisor tidak", async () => {
    const { canSee } = await import("../lib/nav");
    expect(canSee(["medical.verify"], "/medical")).toBe(true);
    expect(canSee(["medical.read_status"], "/medical")).toBe(false);
    expect(canSee(["medical.read_status", "medical.read_detail", "medical.update"], "/medical")).toBe(false);
  });
});

describe("Antrean verifikasi gabungan (M3.6b)", () => {
  const base = { worker_name: "Budi Sintetis", sho_id: "SHO-0001" };
  const now = Date.parse("2026-11-28T00:00:00Z");

  it("menggabungkan empat modul, terlama dahulu, dengan jenis, nama data, dan tanda pembuat", async () => {
    const { mergeQueue } = await import("../lib/verifications");
    const q = mergeQueue(
      {
        COMPETENCY: [
          {
            ...base,
            id: "c1",
            worker_id: "w1",
            updated_at: "2026-11-27T08:00:00Z",
            can_verify: true,
            competency: { name: "Las" },
          },
        ] as never,
        AUTHORIZATION: [
          {
            ...base,
            id: "a1",
            worker_id: "w2",
            updated_at: "2026-11-20T08:00:00Z",
            can_verify: false,
            authorization_type: { name: "Kerja Panas" },
          },
        ] as never,
        SIMPER: [
          {
            ...base,
            id: "s1",
            worker_id: "w3",
            updated_at: "2026-11-25T08:00:00Z",
            can_verify: true,
            simper_type: { name: "SIMPER Tambang" },
          },
        ] as never,
        MEDICAL: [
          {
            ...base,
            id: "m1",
            worker_id: "w4",
            updated_at: "2026-11-26T08:00:00Z",
            can_determine: true,
            exam_type: { name: "MCU Berkala" },
          },
        ] as never,
      },
      now,
    );
    expect(q.map((e) => e.kind)).toEqual(["AUTHORIZATION", "SIMPER", "MEDICAL", "COMPETENCY"]);
    expect(q[0]).toMatchObject({ itemName: "Kerja Panas", mine: true, waitingDays: 7, key: "AUTHORIZATION:a1" });
    expect(q[3]).toMatchObject({ itemName: "Las", mine: false, waitingDays: 0 });
    expect(mergeQueue({}, now)).toEqual([]);
  });

  it("label lama menunggu menandai lebih dari 3 hari", async () => {
    const { waitingLabel } = await import("../lib/verifications");
    expect(waitingLabel(0)).toEqual({ text: "hari ini", overdue: false });
    expect(waitingLabel(3)).toEqual({ text: "3 hari", overdue: false });
    expect(waitingLabel(4)).toEqual({ text: "4 hari", overdue: true });
  });

  it("menu Antrean Verifikasi untuk pemegang izin verifikasi mana pun; Supervisor dan pekerja tidak", async () => {
    const { canSee } = await import("../lib/nav");
    const { QUEUE_SOURCES } = await import("../lib/verifications");
    for (const s of QUEUE_SOURCES) expect(canSee([s.permission], "/verifications")).toBe(true);
    expect(canSee(["medical.read_status", "worker.read"], "/verifications")).toBe(false);
    expect(canSee([], "/verifications")).toBe(false);
  });
});

describe("Readiness dan Syarat Jabatan (M4.2)", () => {
  it("validasi draf: rujukan wajib, hari peringatan 0..365, syarat tidak ganda", async () => {
    const { validateDraft, emptyDraftItem } = await import("../lib/readiness");
    const row = { ...emptyDraftItem(), ref: "c1" };
    expect(validateDraft([])).toBeNull();
    expect(validateDraft([emptyDraftItem()])).toMatch(/pilih kompetensi/);
    expect(validateDraft([{ ...row, warning_days: "400" }])).toMatch(/0 sampai 365/);
    expect(validateDraft([{ ...row, warning_days: "" }])).toMatch(/0 sampai 365/);
    expect(validateDraft([row, { ...row, uid: "x" }])).toMatch(/sudah ada/);
    // SIMPER sama dengan kelas alat berbeda bukan syarat ganda
    const s = { ...emptyDraftItem(), item_type: "SIMPER" as const, ref: "s1", classId: "dt" };
    expect(validateDraft([s, { ...s, uid: "y", classId: "exc" }])).toBeNull();
  });

  it("isi permintaan memakai kolom rujukan sesuai jenis; kelas alat hanya SIMPER", async () => {
    const { draftPayload, draftFromProfile } = await import("../lib/readiness");
    const payload = draftPayload([
      { uid: "1", item_type: "MEDICAL", ref: "m1", classId: "abaikan", is_mandatory: true, warning_days: "14" },
      { uid: "2", item_type: "SIMPER", ref: "s1", classId: "dt", is_mandatory: false, warning_days: "30" },
    ]);
    expect(payload).toEqual([
      { item_type: "MEDICAL", medical_exam_type_id: "m1", is_mandatory: true, warning_days: 14 },
      { item_type: "SIMPER", simper_type_id: "s1", equipment_class_id: "dt", is_mandatory: false, warning_days: 30 },
    ]);
    const back = draftFromProfile([
      {
        id: "i1",
        item_type: "AUTHORIZATION",
        requirement_name: "Kerja Panas",
        competency_id: null,
        medical_exam_type_id: null,
        authorization_type_id: "a1",
        simper_type_id: null,
        equipment_class_id: null,
        is_mandatory: true,
        warning_days: 7,
        display_order: 1,
      },
    ]);
    expect(back).toEqual([
      { uid: "i1", item_type: "AUTHORIZATION", ref: "a1", classId: "", is_mandatory: true, warning_days: "7" },
    ]);
  });

  it("item medis tersamar tampil dengan kalimat baku tanpa rincian", async () => {
    const { requirementText, requirementBadge } = await import("../lib/readiness");
    const base = {
      profile_item_id: "p",
      item_type: "MEDICAL" as const,
      requirement_name: "Syarat Medical",
      is_mandatory: true,
      expiry_date: null,
      reason_code: "MEDICAL_REQUIREMENT_NOT_MET",
    };
    expect(requirementText({ ...base, requirement_status: "NOT_MET", masked: true })).toBe("Syarat Medical belum terpenuhi");
    expect(requirementText({ ...base, requirement_status: "RESTRICTED", masked: false })).toBe("Dengan pembatasan");
    expect(requirementBadge("VALID")).toBe("badge-success");
    expect(requirementBadge("EXPIRING_SOON")).toBe("badge-warning");
    expect(requirementBadge("NOT_MET")).toBe("badge-denied");
  });

  it("pesan galat Syarat Jabatan dalam bahasa Indonesia", async () => {
    const { readinessErrorMessage } = await import("../lib/readiness");
    const e = (code: string) => readinessErrorMessage({ status: 409, code, details: [], extra: {} });
    expect(e("PROFILE_EMPTY")).toMatch(/minimal satu syarat/);
    expect(e("POSITION_HAS_ACTIVE_PROFILE")).toMatch(/versi baru/);
    expect(e("PROFILE_NOT_DRAFT")).toMatch(/versi baru/);
  });

  it("menu Syarat Jabatan untuk pengelola profile saja (fase P1 dirilis)", async () => {
    const { canSee } = await import("../lib/nav");
    expect(canSee(["readiness_profile.manage"], "/requirement-profiles")).toBe(true);
    expect(canSee(["readiness.read", "worker.read"], "/requirement-profiles")).toBe(false);
  });
});

describe("QR Safety Passport (M4.3)", () => {
  const tok = "0123456789abcdef".repeat(4);

  it("isi QR adalah tautan halaman pindai dengan token di fragmen, bukan SHO ID", async () => {
    const { passportUrl, parseScanned } = await import("../lib/passport");
    const url = passportUrl("https://soh.example/", tok);
    expect(url).toBe(`https://soh.example/passport/scan#t=${tok}`);
    expect(url).not.toMatch(/SHO-/);
    expect(parseScanned(url)).toBe(tok);
    expect(parseScanned(` ${tok} `)).toBe(tok);
    expect(parseScanned(`#t=${tok}`)).toBe(tok);
    expect(parseScanned("SHO-000001")).toBeNull();
    expect(parseScanned(`https://lain.example/?t=${tok}`)).toBeNull();
    expect(parseScanned(`#t=${tok}ff`)).toBeNull();
  });

  it("sisa waktu token tidak negatif", async () => {
    const { secondsLeft } = await import("../lib/passport");
    const now = Date.parse("2026-11-28T10:00:00Z");
    expect(secondsLeft("2026-11-28T10:05:00Z", now)).toBe(300);
    expect(secondsLeft("2026-11-28T09:59:00Z", now)).toBe(0);
  });

  it("pesan galat pindai", async () => {
    const { passportErrorMessage } = await import("../lib/passport");
    expect(passportErrorMessage({ code: "PASSPORT_TOKEN_EXPIRED" })).toMatch(/kedaluwarsa/);
    expect(passportErrorMessage({ code: "NOT_FOUND" })).toMatch(/cakupan/);
  });

  it("menu Pindai QR untuk peran pembaca kesiapan (penuh/tim); pekerja tidak", async () => {
    const { canSee } = await import("../lib/nav");
    expect(canSee(["readiness.read"], "/passport/scan")).toBe(true);
    expect(canSee(["worker.read"], "/passport/scan")).toBe(false);
  });
});

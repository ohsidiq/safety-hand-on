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
      { href: "/x", label: "X", domain: "Readiness" as const, anyOf: ["a"], phase: "P1" as const, built: true },
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

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
    expect(hrefs).toEqual(["/dashboard", "/audit", "/profile"]);
  });

  it("Supervisor (tanpa audit.view) tidak melihat Jejak Audit", async () => {
    const { visibleNav, canSee } = await import("../lib/nav");
    const perms = ["worker.read", "observation.create"];
    expect(visibleNav(perms).map((i) => i.href)).toEqual(["/dashboard", "/profile"]);
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

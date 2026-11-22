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

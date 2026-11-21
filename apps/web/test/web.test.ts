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

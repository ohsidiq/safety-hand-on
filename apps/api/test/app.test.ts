import { describe, expect, it } from "vitest";
import { createApp } from "../src/create-app.js";

describe("Core API: kerangka v1", () => {
  const app = createApp({ allowedOrigins: ["http://localhost:3000"] });

  it("GET /api/v1/health/live mengembalikan UP dengan amplop standar", async () => {
    const res = await app.request("/api/v1/health/live");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, data: { status: "UP" } });
    expect(typeof body.request_id).toBe("string");
    expect(res.headers.get("x-request-id")).toBe(body.request_id);
  });

  it("GET /api/v1/health/ready tanpa database melapor DOWN (503) tanpa detail internal", async () => {
    const res = await app.request("/api/v1/health/ready");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({
      success: false,
      data: { status: "DOWN", schema: { state: "UNKNOWN", expected: expect.stringMatching(/^\d{4}$/), applied: null } },
      request_id: expect.any(String),
    });
  });

  it("memakai X-Request-Id dari klien bila formatnya aman", async () => {
    const res = await app.request("/api/v1/health/live", { headers: { "X-Request-Id": "abc-123" } });
    expect(res.headers.get("x-request-id")).toBe("abc-123");
  });

  it("menolak X-Request-Id yang tidak aman dan membuat yang baru", async () => {
    const res = await app.request("/api/v1/health/live", { headers: { "X-Request-Id": "<script>" } });
    expect(res.headers.get("x-request-id")).not.toBe("<script>");
  });

  it("rute yang tidak ada mengembalikan 404 NOT_FOUND sesuai katalog galat", async () => {
    const res = await app.request("/api/v1/tidak-ada");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
  });

  it("menyertakan header keamanan standar", async () => {
    const res = await app.request("/api/v1/health/live");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("preflight CORS mengizinkan header yang dipakai web, termasuk X-Passport-Token (pindai QR)", async () => {
    const res = await app.request("/api/v1/passport/verify", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization,x-passport-token",
      },
    });
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase().split(",");
    for (const h of ["authorization", "content-type", "if-match", "x-passport-token"]) expect(allowed).toContain(h);
  });

  it("CORS hanya untuk asal yang diizinkan", async () => {
    const ok = await app.request("/api/v1/health/live", { headers: { Origin: "http://localhost:3000" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const bad = await app.request("/api/v1/health/live", { headers: { Origin: "https://jahat.contoh" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("kontrak OpenAPI 3.1 memuat endpoint health", async () => {
    const res = await app.request("/api/v1/openapi.json");
    const spec = await res.json();
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(["/api/v1/health/live", "/api/v1/health/ready"]));
  });
});

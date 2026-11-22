import { describe, expect, it } from "vitest";
import { sslOptions } from "../src/index.js";

describe("sslOptions", () => {
  it("tanpa TLS untuk database lokal", () => {
    expect(sslOptions("postgres://u@localhost:5432/db")).toBeUndefined();
    expect(sslOptions("postgres://u@127.0.0.1/db")).toBeUndefined();
  });

  it("host jarak jauh selalu terenkripsi", () => {
    expect(sslOptions("postgres://u:p@db.contoh.com:6543/postgres", "")).toEqual({ rejectUnauthorized: false });
  });

  it("verifikasi penuh bila CA disediakan", () => {
    expect(sslOptions("postgres://u:p@db.contoh.com/postgres", "PEM")).toEqual({ ca: "PEM", rejectUnauthorized: true });
  });
});

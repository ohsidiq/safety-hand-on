import { describe, expect, it } from "vitest";
import { parseConnectionString, sslOptions } from "../src/index.js";

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

describe("parseConnectionString", () => {
  it("galat URI tidak valid tidak pernah memuat isi connection string (password)", () => {
    const secret = "RahasiaSuper#123";
    let message = "";
    try {
      parseConnectionString(`postgresql://u:(${secret})@host.contoh:6543/postgres`);
    } catch (e) {
      message = `${(e as Error).message} ${JSON.stringify(e)}`;
    }
    expect(message).toContain("DATABASE_URL tidak valid");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("host.contoh");
  });
});

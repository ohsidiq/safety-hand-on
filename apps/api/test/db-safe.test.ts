import { afterEach, describe, expect, it, vi } from "vitest";
import { createPoolSafe } from "../src/db.js";

describe("createPoolSafe", () => {
  afterEach(() => vi.restoreAllMocks());

  it("tanpa DATABASE_URL tidak membuat pool", () => {
    expect(createPoolSafe("")).toBeUndefined();
  });

  it("URI rusak: tidak melempar, log hanya kode galat tanpa password", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(createPoolSafe("postgresql://u:(Rahasia#1)@host.contoh:6543/postgres")).toBeUndefined();
    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).toContain("DATABASE_URL_INVALID");
    expect(logged).not.toContain("Rahasia");
    expect(logged).not.toContain("host.contoh");
  });
});

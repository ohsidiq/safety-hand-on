import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXPECTED_SCHEMA, schemaState } from "../src/schema-version.js";

describe("versi skema yang diharapkan kode", () => {
  it("sama dengan migrasi terbaru di db/migrations (naikkan EXPECTED_SCHEMA saat menambah migrasi)", () => {
    const dir = fileURLToPath(new URL("../../../db/migrations/", import.meta.url));
    const latest = readdirSync(dir)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .map((f) => f.slice(0, 4))
      .sort()
      .at(-1);
    expect(EXPECTED_SCHEMA).toBe(latest);
  });

  it("status sinkron: BEHIND bila database tertinggal, AHEAD bila lebih baru, UNKNOWN bila kosong", () => {
    expect(schemaState("0021", "0021")).toBe("IN_SYNC");
    expect(schemaState("0020", "0021")).toBe("BEHIND");
    expect(schemaState("0022", "0021")).toBe("AHEAD");
    expect(schemaState(null, "0021")).toBe("UNKNOWN");
  });
});

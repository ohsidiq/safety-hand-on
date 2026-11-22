import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { createApp } from "../create-app.js";

/**
 * Menulis kontrak OpenAPI ke openapi/v1.yaml (sumber kebenaran kontrak, API-000 bagian 3).
 * `--check` gagal bila berkas di repositori berbeda dari kode, dipakai di CI (ARCH-003).
 */
const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "../../../../openapi/v1.yaml");

const res = await createApp().request("/api/v1/openapi.json");
const spec = await res.json();
const yaml = `# Dibangkitkan oleh: pnpm --filter @soh/api openapi. Jangan diubah manual.\n${stringify(spec)}`;

if (process.argv.includes("--check")) {
  const { readFileSync, existsSync } = await import("node:fs");
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (current !== yaml) {
    console.error("openapi/v1.yaml tidak sinkron dengan kode. Jalankan: pnpm --filter @soh/api openapi");
    process.exit(1);
  }
  console.log("openapi/v1.yaml sinkron");
} else {
  writeFileSync(target, yaml);
  console.log(`ditulis: ${target}`);
}

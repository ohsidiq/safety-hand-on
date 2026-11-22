import { createPool } from "@soh/db";
import { handlers } from "./handlers.js";
import { processBatch } from "./outbox.js";

const db = createPool();
const batchSize = Number(process.env.WORKER_BATCH_SIZE ?? 50);
const intervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2000);
const once = process.argv.includes("--once");

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopping = true;
  });
}

async function tick() {
  const r = await processBatch(db, handlers, { batchSize });
  if (r.claimed > 0) {
    console.log(JSON.stringify({ level: "info", msg: "outbox batch", ...r }));
  }
  if (r.failed > 0) {
    // Alert antrean gagal (ARCH-006). Penyedia alert dipasang lewat antarmuka internal (ARCH-007).
    console.error(JSON.stringify({ level: "error", msg: "outbox events moved to failed queue", failed: r.failed }));
  }
  return r;
}

if (once) {
  // Mode sekali jalan: cocok untuk cron terjadwal (paket gratis) atau uji.
  let r = await tick();
  while (r.claimed === batchSize) r = await tick();
} else {
  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "worker tick failed", error: String(err).slice(0, 200) }));
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
await db.end();

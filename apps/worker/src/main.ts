import { createPool } from "@soh/db";
import { drainAudit, ensureAuditPartitions } from "./audit.js";
import { handlers } from "./handlers.js";
import { processNotifications } from "./notifications.js";
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

let lastPartitionCheck = 0;

async function tick() {
  if (Date.now() - lastPartitionCheck > 6 * 60 * 60 * 1000) {
    const created = await ensureAuditPartitions(db);
    if (created > 0) console.log(JSON.stringify({ level: "info", msg: "audit partitions created", created }));
    lastPartitionCheck = Date.now();
  }
  const audit = await drainAudit(db);
  if (audit.moved > 0) console.log(JSON.stringify({ level: "info", msg: "audit batch", ...audit }));
  if (audit.failed > 0) {
    // AUD-009: kegagalan pencatatan memicu alert dan kejadian tidak hilang (tetap di antrean gagal)
    console.error(JSON.stringify({ level: "error", msg: "audit events moved to failed queue", failed: audit.failed }));
  }
  const notif = await processNotifications(db);
  if (notif.processed > 0) console.log(JSON.stringify({ level: "info", msg: "notification batch", ...notif }));
  if (notif.failed > 0) {
    // FR-PLT02-012: antrean gagal memicu alert
    console.error(JSON.stringify({ level: "error", msg: "notification events moved to failed queue", failed: notif.failed }));
  }
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

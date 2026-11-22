import { Hono } from "hono";
import { authVerifierFromEnv } from "./auth.js";
import { allowedOriginsFromEnv } from "./config.js";
import { createApp } from "./create-app.js";
import { createPoolSafe } from "./db.js";
import { pushSenderFromEnv } from "./push-sender.js";

/**
 * Entrypoint Vercel (Hono zero-config): ekspor default aplikasi Hono. Detektor Vercel mensyaratkan
 * berkas ini mengimpor `hono` secara langsung; aplikasi inti (OpenAPIHono, turunan Hono) diekspor apa adanya
 * agar penanganan 404 dan galat tetap memakai amplop API-000.
 * Pool dibuat sekali per instance fungsi dan dipakai ulang antar permintaan (Fluid compute).
 * DATABASE_URL memakai Supabase transaction pooler. `SET LOCAL` dan `set_config(..., true)`
 * di `withUser` berlaku per transaksi, jadi aman untuk mode transaction pooling.
 */
const db = createPoolSafe();

const app = createApp({
  db,
  allowedOrigins: allowedOriginsFromEnv(),
  pushSender: pushSenderFromEnv(),
  auth: authVerifierFromEnv(),
});
if (!(app instanceof Hono)) {
  throw new Error("Core API harus berupa aplikasi Hono");
}

export default app;

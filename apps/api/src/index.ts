import { createPool } from "@soh/db";
import { allowedOriginsFromEnv } from "./config.js";
import { createApp } from "./create-app.js";

/**
 * Entrypoint Vercel (Hono zero-config): ekspor default aplikasi.
 * Pool dibuat sekali per instance fungsi dan dipakai ulang antar permintaan (Fluid compute).
 * DATABASE_URL memakai Supabase transaction pooler. `SET LOCAL` dan `set_config(..., true)`
 * di `withUser` berlaku per transaksi, jadi aman untuk mode transaction pooling.
 */
const db = process.env.DATABASE_URL ? createPool() : undefined;

export default createApp({ db, allowedOrigins: allowedOriginsFromEnv() });

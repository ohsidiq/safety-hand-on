import { serve } from "@hono/node-server";
import { createPool } from "@soh/db";
import { createApp } from "./app.js";

const port = Number(process.env.API_PORT ?? 8787);
const allowedOrigins = (process.env.API_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const db = process.env.DATABASE_URL ? createPool() : undefined;
const app = createApp({ db, allowedOrigins });

serve({ fetch: app.fetch, port }, (info) => {
  // Log terstruktur tanpa data sensitif (API-000 bagian 17)
  console.log(JSON.stringify({ level: "info", msg: "core-api listening", port: info.port, db: Boolean(db) }));
});

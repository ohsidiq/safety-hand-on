import { serve } from "@hono/node-server";
import { authVerifierFromEnv } from "./auth.js";
import { allowedOriginsFromEnv } from "./config.js";
import { createApp } from "./create-app.js";
import { createPoolSafe } from "./db.js";
import { nationalIdCryptoFromEnv } from "./national-id.js";
import { pushSenderFromEnv } from "./push-sender.js";

// Server lokal untuk pengembangan. Di Vercel dipakai src/index.ts.
const port = Number(process.env.API_PORT ?? 8787);
const db = createPoolSafe();
const app = createApp({
  db,
  allowedOrigins: allowedOriginsFromEnv(),
  pushSender: pushSenderFromEnv(),
  auth: authVerifierFromEnv(),
  nationalId: nationalIdCryptoFromEnv(),
});

serve({ fetch: app.fetch, port }, (info) => {
  // Log terstruktur tanpa data sensitif (API-000 bagian 17)
  console.log(JSON.stringify({ level: "info", msg: "core-api listening", port: info.port, db: Boolean(db) }));
});

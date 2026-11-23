import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AuthEnv } from "./auth.js";
import { errorBody } from "./errors.js";

/**
 * SPIKE S-6 (sementara): uji Web Push ke PWA, terutama iOS yang dipasang ke Home Screen.
 * Bukan fitur produk. Dihapus atau diganti PLT02 (Notification) di M1.
 *
 * Pengaman karena endpoint ini tanpa autentikasi:
 * - Aktif hanya bila SPIKE_PUSH_ENABLED=true dan kunci VAPID tersedia; selain itu 404.
 * - Isi notifikasi tetap (teks uji), tidak memuat data pengguna atau data sensitif.
 * - Hanya ke layanan push resmi (Apple, Google, Mozilla, Microsoft).
 * - Batas laju sederhana per instance.
 */

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Antarmuka internal penyedia push (ARCH-007). */
export type PushSender = (subscription: PushSubscriptionInput, payload: string) => Promise<void>;

export const PUSH_HOST_ALLOWLIST = [
  /^web\.push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && PUSH_HOST_ALLOWLIST.some((re) => re.test(url.hostname));
  } catch {
    return false;
  }
}

const Subscription = z
  .object({
    endpoint: z.string().url().max(2048),
    keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(64) }),
  })
  .openapi("PushSubscription");

const route = createRoute({
  method: "post",
  path: "/spike/push-test",
  tags: ["Spike S-6"],
  summary: "SPIKE: kirim notifikasi uji ke langganan Web Push (sementara, nonaktif secara bawaan)",
  request: { body: { content: { "application/json": { schema: z.object({ subscription: Subscription }) } }, required: true } },
  responses: {
    202: {
      content: {
        "application/json": {
          schema: z.object({ success: z.boolean(), data: z.object({ sent: z.boolean() }), request_id: z.string() }),
        },
      },
      description: "Notifikasi uji dikirim ke layanan push",
    },
    404: { description: "Spike tidak aktif" },
    422: { description: "Langganan tidak valid atau layanan push tidak diizinkan" },
    429: { description: "Terlalu banyak permintaan" },
    502: { description: "Layanan push menolak" },
  },
});

type Env = AuthEnv;

export function registerSpikePush(app: OpenAPIHono<Env>, sender: PushSender | undefined, now = () => Date.now()) {
  const hits: number[] = [];
  const LIMIT = 20; // per menit per instance

  app.openapi(route, async (c) => {
    const rid = c.get("requestId");
    if (!sender) return c.json(errorBody("NOT_FOUND", rid), 404);

    const t = now();
    while (hits.length && (hits[0] ?? 0) < t - 60_000) hits.shift();
    if (hits.length >= LIMIT) return c.json(errorBody("RATE_LIMITED", rid), 429);
    hits.push(t);

    const { subscription } = c.req.valid("json");
    if (!isAllowedPushEndpoint(subscription.endpoint)) return c.json(errorBody("VALIDATION_ERROR", rid), 422);

    const payload = JSON.stringify({
      title: "Safety On Hand",
      body: "Notifikasi uji S-6 berhasil diterima.",
      url: "/uji-push",
    });
    try {
      await sender(subscription, payload);
    } catch (err) {
      const status = (err as { statusCode?: unknown }).statusCode;
      console.error(JSON.stringify({ level: "error", msg: "spike push failed", status, request_id: rid }));
      return c.json(errorBody("SERVICE_UNAVAILABLE", rid), 502);
    }
    return c.json({ success: true, data: { sent: true }, request_id: rid }, 202);
  });
}

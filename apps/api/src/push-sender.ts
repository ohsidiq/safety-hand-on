import webpush from "web-push";
import type { PushSender } from "./spike-push.js";

/**
 * Penyedia Web Push (VAPID) dari variabel lingkungan. Mengembalikan undefined bila spike tidak aktif
 * atau kunci belum lengkap. Kunci privat hanya dibaca dari env (ARCH-009), tidak pernah dicatat.
 */
export function pushSenderFromEnv(env = process.env): PushSender | undefined {
  const { SPIKE_PUSH_ENABLED, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = env;
  if (SPIKE_PUSH_ENABLED !== "true" || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return undefined;
  const details = {
    subject: VAPID_SUBJECT || "mailto:admin@contoh.invalid",
    publicKey: VAPID_PUBLIC_KEY,
    privateKey: VAPID_PRIVATE_KEY,
  };
  return async (subscription, payload) => {
    await webpush.sendNotification(subscription, payload, { vapidDetails: details, TTL: 300, urgency: "high" });
  };
}

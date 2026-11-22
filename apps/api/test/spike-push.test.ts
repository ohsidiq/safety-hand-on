import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/create-app.js";
import { pushSenderFromEnv } from "../src/push-sender.js";
import { isAllowedPushEndpoint } from "../src/spike-push.js";

const sub = (endpoint: string) => ({ subscription: { endpoint, keys: { p256dh: "BKey", auth: "auth" } } });
const post = (app: ReturnType<typeof createApp>, body: unknown) =>
  app.request("/api/v1/spike/push-test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("SPIKE S-6 push-test", () => {
  it("nonaktif secara bawaan: 404", async () => {
    const res = await post(createApp(), sub("https://web.push.apple.com/abc"));
    expect(res.status).toBe(404);
  });

  it("pushSenderFromEnv hanya aktif bila flag dan kedua kunci ada", () => {
    expect(pushSenderFromEnv({})).toBeUndefined();
    expect(pushSenderFromEnv({ SPIKE_PUSH_ENABLED: "true", VAPID_PUBLIC_KEY: "x" })).toBeUndefined();
    expect(pushSenderFromEnv({ SPIKE_PUSH_ENABLED: "false", VAPID_PUBLIC_KEY: "x", VAPID_PRIVATE_KEY: "y" })).toBeUndefined();
    expect(pushSenderFromEnv({ SPIKE_PUSH_ENABLED: "true", VAPID_PUBLIC_KEY: "x", VAPID_PRIVATE_KEY: "y" })).toBeTypeOf(
      "function",
    );
  });

  it("mengirim isi tetap tanpa data pengguna ke layanan push Apple", async () => {
    const sender = vi.fn(async () => {});
    const res = await post(createApp({ pushSender: sender }), sub("https://web.push.apple.com/QAB"));
    expect(res.status).toBe(202);
    expect(sender).toHaveBeenCalledOnce();
    const payload = JSON.parse((sender.mock.calls[0] as unknown as [unknown, string])[1]);
    expect(payload).toEqual({ title: "Safety On Hand", body: "Notifikasi uji S-6 berhasil diterima.", url: "/uji-push" });
  });

  it("menolak endpoint di luar layanan push resmi (bukan relay bebas)", async () => {
    const sender = vi.fn(async () => {});
    const res = await post(createApp({ pushSender: sender }), sub("https://jahat.contoh/hook"));
    expect(res.status).toBe(422);
    expect(sender).not.toHaveBeenCalled();
  });

  it("validasi skema: badan tidak lengkap 422", async () => {
    const res = await post(createApp({ pushSender: vi.fn() }), { subscription: { endpoint: "x" } });
    expect(res.status).toBe(422);
  });

  it("galat layanan push menjadi 502 tanpa detail", async () => {
    const sender = vi.fn(async () => {
      throw Object.assign(new Error("gone"), { statusCode: 410 });
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post(createApp({ pushSender: sender }), sub("https://fcm.googleapis.com/fcm/send/x"));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ success: false, error: { code: "SERVICE_UNAVAILABLE" } });
  });

  it("daftar putih host", () => {
    expect(isAllowedPushEndpoint("https://web.push.apple.com/a")).toBe(true);
    expect(isAllowedPushEndpoint("https://wns2-par02p.notify.windows.com/w/?token=1")).toBe(true);
    expect(isAllowedPushEndpoint("http://web.push.apple.com/a")).toBe(false);
    expect(isAllowedPushEndpoint("https://web.push.apple.com.jahat.contoh/a")).toBe(false);
  });
});

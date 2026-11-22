/** Utilitas Web Push sisi klien (spike S-6). */

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export interface PushEnvironment {
  supported: boolean;
  isIOS: boolean;
  standalone: boolean;
  permission: NotificationPermission | "unsupported";
}

export function detectPushEnvironment(nav: Navigator, win: Window): PushEnvironment {
  const ua = nav.userAgent || "";
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && (nav.maxTouchPoints ?? 0) > 1);
  const standalone =
    win.matchMedia?.("(display-mode: standalone)").matches === true ||
    (nav as Navigator & { standalone?: boolean }).standalone === true;
  const supported = "serviceWorker" in nav && "PushManager" in win && "Notification" in win;
  const permission = "Notification" in win ? Notification.permission : "unsupported";
  return { supported, isIOS, standalone, permission };
}

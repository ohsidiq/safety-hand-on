"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, NOTIFICATIONS_CHANGED, type NotificationItem, safeInternalLink } from "@/lib/api";
import { useSession } from "@/lib/session";
import { formatTime } from "../time";

const PRIORITY_LABEL: Record<NotificationItem["priority"], string> = {
  LOW: "Rendah",
  MEDIUM: "Sedang",
  HIGH: "Tinggi",
  CRITICAL: "Kritis",
};

/** Kotak masuk (UIUX-002 §9, API-015 §2). Isi tidak memuat data sensitif; detail ada di objek tujuan. */
export function NotificationsView() {
  const { getToken } = useSession();
  const router = useRouter();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [state, setState] = useState<"loading" | "idle" | "error">("loading");

  const load = useCallback(
    async (next?: string) => {
      const token = await getToken();
      if (!token) return;
      setState("loading");
      const q = new URLSearchParams({ limit: "25" });
      if (unreadOnly) q.set("unread_only", "true");
      if (next) q.set("cursor", next);
      const r = await apiGet<NotificationItem[]>(`/notifications?${q}`, token);
      if (!r.ok) {
        setState("error");
        return;
      }
      const pagination = (r.body as { pagination?: { next_cursor: string | null; has_more: boolean } }).pagination;
      setItems((prev) => (next ? [...prev, ...r.data] : r.data));
      setCursor(pagination?.has_more ? pagination.next_cursor : null);
      setState("idle");
    },
    [getToken, unreadOnly],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const changed = () => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));

  async function act(item: NotificationItem, action: "read" | "archive") {
    const token = await getToken();
    if (!token) return;
    const r = await apiPost(`/notifications/${item.id}/${action}`, token);
    if (!r.ok) return;
    setItems((prev) =>
      action === "archive"
        ? prev.filter((i) => i.id !== item.id)
        : prev.map((i) => (i.id === item.id ? { ...i, read_at: i.read_at ?? new Date().toISOString() } : i)),
    );
    changed();
  }

  async function open(item: NotificationItem) {
    if (!item.read_at) await act(item, "read");
    const link = safeInternalLink(item.link);
    if (link) router.push(link);
  }

  async function readAll() {
    const token = await getToken();
    if (!token) return;
    const r = await apiPost("/notifications/read-all", token, {});
    if (r.ok) {
      setItems((prev) => prev.map((i) => ({ ...i, read_at: i.read_at ?? new Date().toISOString() })));
      changed();
    }
  }

  return (
    <>
      <div className="toolbar">
        <label className="check">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
          Hanya yang belum dibaca
        </label>
        <button type="button" className="secondary" onClick={readAll} disabled={!items.some((i) => !i.read_at)}>
          Tandai semua dibaca
        </button>
      </div>
      {state === "error" ? <p role="alert">Notifikasi tidak dapat dimuat. Coba lagi.</p> : null}
      <ul className="inbox">
        {items.map((n) => (
          <li key={n.id} className={n.read_at ? "read" : "unread"}>
            <button type="button" className="inbox-item" onClick={() => open(n)}>
              <span className="inbox-title">
                {n.read_at ? null : <span className="sr-only">Belum dibaca: </span>}
                {n.title}
              </span>
              <span className="inbox-body">{n.body}</span>
              <span className="muted small-text">
                {formatTime(n.created_at)} · Prioritas {PRIORITY_LABEL[n.priority]}
              </span>
            </button>
            <button
              type="button"
              className="secondary small"
              onClick={() => act(n, "archive")}
              aria-label={`Arsipkan: ${n.title}`}
            >
              Arsipkan
            </button>
          </li>
        ))}
      </ul>
      {state === "idle" && items.length === 0 ? <p className="muted">Tidak ada notifikasi.</p> : null}
      {state === "loading" ? <p role="status">Memuat…</p> : null}
      {cursor && state === "idle" ? (
        <p>
          <button type="button" className="secondary" onClick={() => load(cursor)}>
            Muat lebih banyak
          </button>
        </p>
      ) : null}
    </>
  );
}

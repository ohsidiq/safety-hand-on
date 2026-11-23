/**
 * Klien Core API. Klien web tidak membaca tabel database langsung (ARCH-001):
 * semua operasi bisnis lewat Core API pada basis /api/v1.
 */
export function apiBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/+$/, "");
}

export function apiUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${apiBaseUrl()}/api/v1${p}`;
}

export type ApiStatus = "UP" | "DOWN" | "UNKNOWN";

export async function fetchApiStatus(fetcher: typeof fetch = fetch): Promise<ApiStatus> {
  if (!apiBaseUrl()) return "UNKNOWN";
  try {
    const res = await fetcher(apiUrl("/health/live"), { cache: "no-store" });
    if (!res.ok) return "DOWN";
    const body = (await res.json()) as { data?: { status?: string } };
    return body.data?.status === "UP" ? "UP" : "DOWN";
  } catch {
    return "DOWN";
  }
}

export interface Me {
  user_id: string;
  organization: { id: string; name: string; code: string | null } | null;
  full_name: string | null;
  worker_id: string | null;
  language: "id" | "en";
  role_assignments: { id: string; role_code: string; scope_type: string; scope_id: string | null; valid_until: string | null }[];
  permissions: string[];
  mfa_enabled: boolean;
  must_change_credential: boolean;
}

export type MeResult =
  | { ok: true; me: Me }
  | { ok: false; code: "UNAUTHORIZED" | "TOKEN_EXPIRED" | "ACCOUNT_DEACTIVATED" | "ACCOUNT_LOCKED" | "UNAVAILABLE" };

/** GET /api/v1/auth/me dengan token akses Supabase. `permissions` hanya untuk tampilan (AUTH-API-010). */
export async function fetchMe(accessToken: string, fetcher: typeof fetch = fetch): Promise<MeResult> {
  if (!apiBaseUrl()) return { ok: false, code: "UNAVAILABLE" };
  try {
    const res = await fetcher(apiUrl("/auth/me"), {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    const body = (await res.json()) as { data?: Me; error?: { code?: string } };
    if (res.ok && body.data) return { ok: true, me: body.data };
    const code = body.error?.code;
    if (code === "TOKEN_EXPIRED" || code === "ACCOUNT_DEACTIVATED" || code === "ACCOUNT_LOCKED" || code === "UNAUTHORIZED") {
      return { ok: false, code };
    }
    return { ok: false, code: "UNAVAILABLE" };
  } catch {
    return { ok: false, code: "UNAVAILABLE" };
  }
}

export type ApiResult<T> = { ok: true; data: T; body: unknown } | { ok: false; status: number; code: string };

/** GET ke Core API dengan token akses. Galat dikembalikan sebagai kode API-000, bukan dilempar. */
export async function apiGet<T>(path: string, accessToken: string, fetcher: typeof fetch = fetch): Promise<ApiResult<T>> {
  if (!apiBaseUrl()) return { ok: false, status: 0, code: "UNAVAILABLE" };
  try {
    const res = await fetcher(apiUrl(path), { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
    const body = (await res.json().catch(() => ({}))) as { data?: T; error?: { code?: string } };
    if (res.ok && body.data !== undefined) return { ok: true, data: body.data, body };
    return { ok: false, status: res.status, code: body.error?.code ?? "UNAVAILABLE" };
  } catch {
    return { ok: false, status: 0, code: "UNAVAILABLE" };
  }
}

export interface DashboardSummary {
  as_of: string;
  scope: { organization_id: string | null };
  administration?: {
    users: { active: number; invited: number; locked: number; deactivated: number };
    workers: { total: number; with_account: number; missing_job_position: number };
  };
}

export interface AuditEvent {
  id: string;
  occurred_at: string;
  actor_kind: "USER" | "SYSTEM" | "SUPPORT";
  actor: { user_id: string; full_name: string | null; role_code: string | null; scope_type: string | null } | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  site_id: string | null;
  changed_fields: string[] | null;
  changes: Record<string, unknown> | null;
  sensitive_access: boolean;
  access_reason: string | null;
  result: "SUCCESS" | "DENIED" | "FAILED";
  request_id: string | null;
  ip?: string | null;
  user_agent?: string | null;
}

export interface AuditPage {
  data: AuditEvent[];
  pagination: { limit: number; next_cursor: string | null; has_more: boolean };
}

/** Parameter pencarian audit yang dikirim ke API-016. Tidak memuat data sensitif (RT-005). */
export function auditQuery(p: { from: string; to: string; action?: string; result?: string; cursor?: string; limit?: number }) {
  const q = new URLSearchParams({ from: p.from, to: p.to, limit: String(p.limit ?? 25) });
  if (p.action) q.set("action", p.action);
  if (p.result) q.set("result", p.result);
  if (p.cursor) q.set("cursor", p.cursor);
  return `/audit-logs?${q.toString()}`;
}

export async function fetchAuditPage(
  accessToken: string,
  p: Parameters<typeof auditQuery>[0],
  fetcher: typeof fetch = fetch,
): Promise<ApiResult<AuditEvent[]> & { pagination?: AuditPage["pagination"] }> {
  const r = await apiGet<AuditEvent[]>(auditQuery(p), accessToken, fetcher);
  if (!r.ok) return r;
  return { ...r, pagination: (r.body as AuditPage).pagination };
}

/** POST ke Core API dengan token akses. */
export async function apiPost<T>(
  path: string,
  accessToken: string,
  body?: unknown,
  fetcher: typeof fetch = fetch,
): Promise<ApiResult<T>> {
  if (!apiBaseUrl()) return { ok: false, status: 0, code: "UNAVAILABLE" };
  try {
    const res = await fetcher(apiUrl(path), {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
    });
    const parsed = (await res.json().catch(() => ({}))) as { data?: T; error?: { code?: string } };
    if (res.ok && parsed.data !== undefined) return { ok: true, data: parsed.data, body: parsed };
    return { ok: false, status: res.status, code: parsed.error?.code ?? "UNAVAILABLE" };
  } catch {
    return { ok: false, status: 0, code: "UNAVAILABLE" };
  }
}

export interface NotificationItem {
  id: string;
  notification_type: string;
  category: string;
  priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  title: string;
  body: string;
  link: string | null;
  entity: { type: string; id: string } | null;
  created_at: string;
  read_at: string | null;
}

/** Tautan notifikasi hanya rute internal aplikasi (bukan URL luar), selaras CHECK di database. */
export function safeInternalLink(link: string | null): string | null {
  return link && /^\/[a-z0-9/_-]*$/.test(link) ? link : null;
}

/** Nama event jendela agar lencana lonceng diperbarui setelah notifikasi dibaca. */
export const NOTIFICATIONS_CHANGED = "soh:notifications-changed";

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

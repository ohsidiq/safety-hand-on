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

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Klien Supabase di browser HANYA untuk autentikasi (pengecualian ARCH-001: login).
 * Data bisnis tidak pernah dibaca dari tabel lewat klien ini; semuanya lewat Core API.
 * Kunci yang dipakai adalah publishable key (aman di klien). Service-role key tidak pernah ada di web.
 */
let client: SupabaseClient | null | undefined;

export function getSupabase(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  client =
    url && key
      ? createClient(url, key, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
        })
      : null;
  return client;
}

/** Pesan galat login yang tidak membocorkan apakah akun ada (AUTH-API-002). */
export function loginErrorMessage(err: { status?: number; code?: string } | null | undefined): string {
  if (!err) return "";
  if (err.status === 429 || err.code === "over_request_rate_limit")
    return "Terlalu banyak percobaan. Coba lagi beberapa menit lagi.";
  if (err.code === "email_not_confirmed") return "Email belum dikonfirmasi. Periksa kotak masuk Anda.";
  return "Email atau kata sandi salah.";
}

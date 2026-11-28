/**
 * Kembali ke halaman semula setelah login (mis. tautan QR Safety Passport yang dibuka kamera ponsel sebelum masuk).
 * Hanya jalur internal ("/..." tanpa "//") yang diterima agar tidak menjadi pengalihan terbuka. Disimpan di
 * sessionStorage (satu tab, hilang saat tab ditutup).
 */
const KEY = "soh:returnTo";

export function safeReturnPath(path: string | null | undefined): string | null {
  if (!path?.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return null;
  if (path === "/" || path.startsWith("/login")) return null;
  return path;
}

export function rememberReturnTo(storage: Pick<Storage, "setItem">, path: string): void {
  const p = safeReturnPath(path);
  if (p) storage.setItem(KEY, p);
}

export function takeReturnTo(storage: Pick<Storage, "getItem" | "removeItem">): string {
  const p = safeReturnPath(storage.getItem(KEY));
  storage.removeItem(KEY);
  return p ?? "/dashboard";
}

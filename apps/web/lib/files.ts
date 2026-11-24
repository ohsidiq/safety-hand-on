import { apiSend } from "./api";

/** Unggah berkas privat (API-000 §14): daftar -> PUT langsung ke penyimpanan -> complete (pemeriksaan isi). */
export type FilePurpose = "COMPETENCY_CERTIFICATE" | "AUTHORIZATION_DOCUMENT" | "SIMPER_DOCUMENT" | "MEDICAL_DOCUMENT";

export const ACCEPTED_MIME = ["application/pdf", "image/jpeg", "image/png", "image/webp"] as const;
const LIMIT: Record<string, number> = { "application/pdf": 10 * 1024 * 1024 };
const IMAGE_LIMIT = 20 * 1024 * 1024;

export interface UploadedFile {
  id: string;
  scan_status: "PENDING" | "CLEAN" | "INFECTED" | "FAILED";
  scan_detail: string | null;
}

export type UploadResult = { ok: true; file: UploadedFile } | { ok: false; message: string };

/** Validasi di klien (server tetap memeriksa isi). */
export function checkFile(f: { type: string; size: number }): string | null {
  if (!(ACCEPTED_MIME as readonly string[]).includes(f.type)) return "Hanya PDF, JPEG, PNG, atau WebP.";
  const max = LIMIT[f.type] ?? IMAGE_LIMIT;
  if (f.size > max) return `Ukuran maksimum ${Math.round(max / 1024 / 1024)} MB.`;
  if (f.size === 0) return "Berkas kosong.";
  return null;
}

export async function uploadFile(
  token: string,
  file: File,
  purpose: FilePurpose,
  fetcher: typeof fetch = fetch,
): Promise<UploadResult> {
  const invalid = checkFile(file);
  if (invalid) return { ok: false, message: invalid };
  const reg = await apiSend<{ file_id: string; upload_url: string }>(
    "POST",
    "/files",
    token,
    { original_name: file.name.slice(0, 200), mime_type: file.type, size_bytes: file.size, purpose },
    { fetcher },
  );
  if (!reg.ok) {
    if (reg.error.code === "FORBIDDEN") return { ok: false, message: "Anda tidak berwenang mengunggah dokumen ini." };
    if (reg.error.code === "SERVICE_UNAVAILABLE")
      return { ok: false, message: "Penyimpanan dokumen belum tersedia. Coba lagi nanti." };
    return { ok: false, message: "Berkas tidak dapat didaftarkan. Periksa jenis dan ukurannya." };
  }
  try {
    const put = await fetcher(reg.data.upload_url, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
    if (!put.ok) return { ok: false, message: "Unggah terputus. Coba lagi." };
  } catch {
    return { ok: false, message: "Unggah terputus. Periksa koneksi lalu coba lagi." };
  }
  const done = await apiSend<UploadedFile>("POST", `/files/${reg.data.file_id}/complete`, token, undefined, { fetcher });
  if (!done.ok) return { ok: false, message: "Berkas tidak dapat diperiksa. Coba lagi." };
  if (done.data.scan_status !== "CLEAN") {
    return {
      ok: false,
      message:
        done.data.scan_detail === "TYPE_MISMATCH"
          ? "Isi berkas tidak sesuai jenisnya. Gunakan PDF atau foto asli."
          : "Berkas tidak lolos pemeriksaan. Unggah ulang.",
    };
  }
  return { ok: true, file: done.data };
}

/**
 * Penyimpanan berkas privat di balik antarmuka internal (ARCH-007). Implementasi: Supabase Storage (bucket privat).
 * Kunci layanan hanya di Core API (env SUPABASE_SERVICE_ROLE_KEY), tidak pernah ke klien atau log.
 */
export interface FileStorage {
  /** URL unggah bertanda tangan untuk satu obyek (klien PUT langsung ke penyimpanan, API-000 §14). */
  createUploadUrl(bucket: string, path: string): Promise<{ url: string; expiresAt: string }>;
  /** Isi obyek, atau null bila tidak ada. Menolak membaca lebih dari maxBytes (mengembalikan maxBytes+1 bita). */
  read(bucket: string, path: string, maxBytes: number): Promise<Buffer | null>;
  /** URL unduh bertanda tangan berumur pendek. */
  createDownloadUrl(bucket: string, path: string, expiresInSeconds: number, downloadName: string): Promise<string>;
}

export class StorageError extends Error {
  constructor(readonly status: number) {
    super(`storage ${status}`);
  }
}

const SIGNED_UPLOAD_TTL_MS = 2 * 60 * 60 * 1000; // batas Supabase untuk URL unggah bertanda tangan

export function createSupabaseStorage(baseUrl: string, serviceKey: string, fetcher: typeof fetch = fetch): FileStorage {
  const root = `${baseUrl.replace(/\/$/, "")}/storage/v1`;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
  return {
    async createUploadUrl(bucket, path) {
      const res = await fetcher(`${root}/object/upload/sign/${bucket}/${enc(path)}`, { method: "POST", headers });
      if (!res.ok) throw new StorageError(res.status);
      const body = (await res.json()) as { url?: string };
      if (!body.url) throw new StorageError(502);
      return { url: `${root}${body.url}`, expiresAt: new Date(Date.now() + SIGNED_UPLOAD_TTL_MS).toISOString() };
    },
    async read(bucket, path, maxBytes) {
      const res = await fetcher(`${root}/object/authenticated/${bucket}/${enc(path)}`, { headers });
      if (res.status === 404 || res.status === 400) return null;
      if (!res.ok) throw new StorageError(res.status);
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > maxBytes) return Buffer.alloc(maxBytes + 1);
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length > maxBytes ? buf.subarray(0, maxBytes + 1) : buf;
    },
    async createDownloadUrl(bucket, path, expiresInSeconds, downloadName) {
      const res = await fetcher(`${root}/object/sign/${bucket}/${enc(path)}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: expiresInSeconds }),
      });
      if (!res.ok) throw new StorageError(res.status);
      const body = (await res.json()) as { signedURL?: string };
      if (!body.signedURL) throw new StorageError(502);
      const sep = body.signedURL.includes("?") ? "&" : "?";
      return `${root}${body.signedURL}${sep}download=${encodeURIComponent(downloadName)}`;
    },
  };
}

/** Dari SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY. Kosong -> undefined (endpoint file menjawab 503). */
export function storageFromEnv(
  url = process.env.SUPABASE_URL,
  key = process.env.SUPABASE_SERVICE_ROLE_KEY,
): FileStorage | undefined {
  if (!url || !key) return undefined;
  return createSupabaseStorage(url, key);
}

/** Penyimpanan di memori untuk uji. */
export function createMemoryStorage() {
  const objects = new Map<string, Buffer>();
  const storage: FileStorage & { put(bucket: string, path: string, data: Buffer): void; objects: Map<string, Buffer> } = {
    objects,
    put(bucket, path, data) {
      objects.set(`${bucket}/${path}`, data);
    },
    async createUploadUrl(bucket, path) {
      return { url: `memory://upload/${bucket}/${path}`, expiresAt: new Date(Date.now() + SIGNED_UPLOAD_TTL_MS).toISOString() };
    },
    async read(bucket, path, maxBytes) {
      const b = objects.get(`${bucket}/${path}`);
      if (!b) return null;
      return b.length > maxBytes ? b.subarray(0, maxBytes + 1) : b;
    },
    async createDownloadUrl(bucket, path, expiresInSeconds, downloadName) {
      return `memory://download/${bucket}/${path}?expires=${expiresInSeconds}&download=${encodeURIComponent(downloadName)}`;
    },
  };
  return storage;
}

export const metadata = { title: "Offline" };

export default function OfflinePage() {
  return (
    <main className="shell">
      <h1>Tidak ada koneksi</h1>
      <p className="muted">Periksa jaringan Anda, lalu coba lagi. Data tidak disimpan di perangkat ini.</p>
    </main>
  );
}

import { PushTester } from "./tester";

export const metadata = { title: "Uji notifikasi (S-6)" };

export default function UjiPushPage() {
  return (
    <main className="shell">
      <p className="eyebrow">Spike S-6</p>
      <h1>Uji notifikasi push</h1>
      <p className="muted">
        Halaman uji sementara untuk memastikan notifikasi PWA sampai ke perangkat, termasuk iPhone. Isi notifikasi hanya teks uji,
        tanpa data pribadi.
      </p>
      <PushTester />
    </main>
  );
}

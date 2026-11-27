import type { Metadata } from "next";
import { VerificationsView } from "./verifications-view";

export const metadata: Metadata = { title: "Antrean Verifikasi" };

export default function VerificationsPage() {
  return (
    <>
      <h1>Antrean Verifikasi</h1>
      <p className="muted">Semua pengajuan yang menunggu verifikasi atau penetapan Anda, dari yang paling lama menunggu.</p>
      <VerificationsView />
    </>
  );
}

import type { Metadata } from "next";
import { ScanView } from "./scan-view";

export const metadata: Metadata = { title: "Pindai QR" };

export default function PassportScanPage() {
  return (
    <>
      <h1>Pindai QR Safety Passport</h1>
      <p className="muted">
        Arahkan kamera ke QR di ponsel pekerja. Hasil menampilkan status kesiapan tanpa detail medis. Setiap pemindaian tercatat.
      </p>
      <ScanView />
    </>
  );
}

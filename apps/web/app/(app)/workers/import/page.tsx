import type { Metadata } from "next";
import { ImportView } from "./import-view";

export const metadata: Metadata = { title: "Impor pekerja" };

export default function ImportPage() {
  return (
    <>
      <h1>Impor pekerja</h1>
      <p className="muted">
        Unggah CSV sesuai templat (maks 1.000 baris). Periksa dulu, lalu impor. Data sintetis saja sampai syarat perlindungan data
        terpenuhi.
      </p>
      <ImportView />
    </>
  );
}

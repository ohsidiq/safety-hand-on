import type { Metadata } from "next";
import { MedicalView } from "./medical-view";

export const metadata: Metadata = { title: "Medical" };

export default function MedicalPage() {
  return (
    <>
      <h1>Medical</h1>
      <p className="muted">Penetapan Fit to Work dan jenis pemeriksaan. Data medis sensitif: setiap akses detail tercatat.</p>
      <MedicalView />
    </>
  );
}

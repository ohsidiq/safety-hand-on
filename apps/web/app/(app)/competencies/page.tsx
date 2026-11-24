import type { Metadata } from "next";
import { CompetenciesView } from "./competencies-view";

export const metadata: Metadata = { title: "Kompetensi" };

export default function CompetenciesPage() {
  return (
    <>
      <h1>Kompetensi</h1>
      <p className="muted">Verifikasi kompetensi pekerja dan kelola daftar master kompetensi.</p>
      <CompetenciesView />
    </>
  );
}

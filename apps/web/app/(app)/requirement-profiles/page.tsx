import type { Metadata } from "next";
import { RequirementProfilesView } from "./requirement-profiles-view";

export const metadata: Metadata = { title: "Syarat Jabatan" };

export default function RequirementProfilesPage() {
  return (
    <>
      <h1>Syarat Jabatan</h1>
      <p className="muted">
        Daftar syarat (Requirement Profile) per jabatan: kompetensi, MCU, Otorisasi Kerja, dan SIMPER. Status kesiapan pekerja
        dihitung otomatis dari daftar yang aktif.
      </p>
      <RequirementProfilesView />
    </>
  );
}

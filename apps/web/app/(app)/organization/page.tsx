import type { Metadata } from "next";
import { OrganizationView } from "./organization-view";

export const metadata: Metadata = { title: "Struktur Organisasi" };

export default function OrganizationPage() {
  return (
    <>
      <h1>Struktur Organisasi</h1>
      <p className="muted">
        Site, department, divisi, tim, Job Position, dan kelas alat. Data tidak dihapus: yang tidak dipakai dinonaktifkan. Setiap
        perubahan tercatat di Jejak Audit.
      </p>
      <OrganizationView />
    </>
  );
}

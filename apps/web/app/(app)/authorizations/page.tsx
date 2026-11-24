import type { Metadata } from "next";
import { AuthorizationsView } from "./authorizations-view";

export const metadata: Metadata = { title: "Otorisasi Kerja" };

export default function AuthorizationsPage() {
  return (
    <>
      <h1>Otorisasi Kerja</h1>
      <p className="muted">Izin milik pekerja (mis. kerja di ketinggian). Bukan Permit To Work per pekerjaan.</p>
      <AuthorizationsView />
    </>
  );
}

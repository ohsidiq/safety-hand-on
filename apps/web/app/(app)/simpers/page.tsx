import type { Metadata } from "next";
import { SimpersView } from "./simpers-view";

export const metadata: Metadata = { title: "SIMPER" };

export default function SimpersPage() {
  return (
    <>
      <h1>SIMPER</h1>
      <p className="muted">Izin mengoperasikan alat atau kendaraan, per kelas alat.</p>
      <SimpersView />
    </>
  );
}

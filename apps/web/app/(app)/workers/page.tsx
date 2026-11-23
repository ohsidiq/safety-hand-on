import type { Metadata } from "next";
import { WorkersView } from "./workers-view";

export const metadata: Metadata = { title: "Pekerja" };

export default function WorkersPage() {
  return (
    <>
      <h1>Pekerja</h1>
      <p className="muted">Daftar pekerja dalam cakupan Anda. NIK tidak ditampilkan dan tidak dapat dicari.</p>
      <WorkersView />
    </>
  );
}

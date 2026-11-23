import type { Metadata } from "next";
import { NewWorkerView } from "./new-worker-view";

export const metadata: Metadata = { title: "Tambah pekerja" };

export default function NewWorkerPage() {
  return (
    <>
      <h1>Tambah pekerja</h1>
      <p className="muted">SHO ID dibuat otomatis. Data sintetis saja sampai syarat perlindungan data terpenuhi.</p>
      <NewWorkerView />
    </>
  );
}

import type { Metadata } from "next";
import { Suspense } from "react";
import { AuditView } from "./audit-view";

export const metadata: Metadata = { title: "Jejak Audit" };

export default function AuditPage() {
  return (
    <>
      <h1>Jejak Audit</h1>
      <p className="muted">Catatan tidak dapat diubah atau dihapus. Membuka halaman ini juga tercatat.</p>
      <Suspense fallback={<p role="status">Memuat…</p>}>
        <AuditView />
      </Suspense>
    </>
  );
}

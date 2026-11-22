import { ApiStatusBadge } from "./status";

export default function HomePage() {
  return (
    <main className="shell">
      <p className="eyebrow">Safety On Hand</p>
      <h1>Siapkah pekerja ini bekerja hari ini?</h1>
      <p className="muted">
        Platform kesiapan kerja dan kepatuhan keselamatan. Versi ini adalah fondasi (M0): aplikasi kosong, Core API, dan worker.
        Semua data bersifat sintetis.
      </p>
      <section className="card" aria-labelledby="status-heading">
        <h2 id="status-heading">Status sistem</h2>
        <ApiStatusBadge />
      </section>
    </main>
  );
}

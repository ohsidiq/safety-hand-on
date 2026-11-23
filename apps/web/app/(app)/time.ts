/** Waktu disimpan UTC dan ditampilkan dalam zona waktu perangkat (BR-PLT03-006; zona Site menyusul di M2). */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(d);
}

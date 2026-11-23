export const DAY = 24 * 60 * 60 * 1000;
export const MAX_DAYS = 92; // API-016 AUD-API-003

export function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Rentang tanggal (hari kalender perangkat) menjadi rentang UTC [from, to). */
export function rangeFromDates(fromDate: string, toDate: string): { from: string; to: string } | null {
  const f = new Date(`${fromDate}T00:00:00`);
  const t = new Date(`${toDate}T00:00:00`);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || t < f) return null;
  const end = new Date(t.getTime() + DAY);
  if (end.getTime() - f.getTime() > MAX_DAYS * DAY) return null;
  return { from: f.toISOString(), to: end.toISOString() };
}

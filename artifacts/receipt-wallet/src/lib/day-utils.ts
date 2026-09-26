// Pure date helpers for the Transactions page's Daily view. Dates are plain
// "YYYY-MM-DD" strings in the user's local calendar -- the same shape the API's
// `date` field uses -- so there is no timezone conversion to get wrong between
// what's shown and what the list filters on.

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function parse(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function format(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDays(iso: string, delta: number): string {
  const d = parse(iso);
  d.setDate(d.getDate() + delta);
  return format(d);
}

/** Sunday of the week containing `iso`, and the following Saturday. */
export function weekBounds(iso: string): { start: string; end: string } {
  const start = addDays(iso, -parse(iso).getDay());
  return { start, end: addDays(start, 6) };
}

export function friendlyDate(iso: string): string {
  const today = todayIso();
  if (iso === today) return "Today";
  if (iso === addDays(today, -1)) return "Yesterday";
  return parse(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: parse(iso).getFullYear() === parse(today).getFullYear() ? undefined : "numeric" });
}

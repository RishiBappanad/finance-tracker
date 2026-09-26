/**
 * Pure logic for recurring items (schema/recurring_items.ts): cadence dates,
 * the "days to do it" window around each date, and the configurable to-do that
 * an occurrence turns into. No I/O, so all of it is unit-tested directly.
 *
 * Dates are plain "YYYY-MM-DD" strings handled in UTC, the shape the database
 * `date` columns and the rest of this API already use, so there's no timezone
 * conversion to get wrong between what's stored and what's compared.
 */

// ── Dates ────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateString(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const d = parseDate(value);
  return formatDate(d) === value; // rejects 2026-02-30 and the like
}

export function parseDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = parseDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return formatDate(d);
}

export function todayUtc(now: Date = new Date()): string {
  return formatDate(now);
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** The date in month `monthOffset` after `anchor`'s month, on `day` clamped to that month's length. */
function monthDate(anchor: string, monthOffset: number, day: number): string {
  const a = parseDate(anchor);
  const total = a.getUTCFullYear() * 12 + a.getUTCMonth() + monthOffset;
  const year = Math.floor(total / 12);
  const month = total % 12;
  return formatDate(new Date(Date.UTC(year, month, Math.min(day, daysInMonth(year, month)))));
}

// ── Cadence ──────────────────────────────────────────────────────────────────

export const CADENCES = ["weekly", "biweekly", "semi_monthly", "monthly", "annually", "custom"] as const;
export type Cadence = (typeof CADENCES)[number];

export function isValidCadence(value: unknown): value is Cadence {
  return typeof value === "string" && (CADENCES as readonly string[]).includes(value);
}

export interface CadenceSpec {
  cadence: Cadence;
  anchorDate: string;
  intervalDays?: number | null; // required for 'custom'
}

/**
 * The n-th occurrence date (n = 0 is the anchor itself), computed from the
 * ANCHOR each time rather than by stepping from the previous date -- stepping
 * would drift (Jan 31 -> Feb 28 -> Mar 28...) where anchoring keeps "the 31st"
 * meaning the last day of every month that has one.
 *
 * semi_monthly is two dates a month, 15 days apart: an anchor on the 1st means
 * the 1st and 16th; an anchor on the 20th means the 5th and 20th.
 */
export function nthOccurrence(spec: CadenceSpec, n: number): string {
  const { cadence, anchorDate } = spec;
  switch (cadence) {
    case "weekly":
      return addDays(anchorDate, 7 * n);
    case "biweekly":
      return addDays(anchorDate, 14 * n);
    case "custom":
      return addDays(anchorDate, (spec.intervalDays ?? 1) * n);
    case "monthly":
      return monthDate(anchorDate, n, parseDate(anchorDate).getUTCDate());
    case "annually":
      return monthDate(anchorDate, 12 * n, parseDate(anchorDate).getUTCDate());
    case "semi_monthly": {
      const day = parseDate(anchorDate).getUTCDate();
      const first = day > 15 ? day - 15 : day;
      const days = [first, first + 15];
      const anchorSlot = day > 15 ? 1 : 0;
      const k = n + anchorSlot;
      return monthDate(anchorDate, Math.floor(k / 2), days[k % 2]);
    }
  }
}

/** Every occurrence date from the anchor up to and including `through`, in order. */
export function occurrencesThrough(spec: CadenceSpec, through: string, maxCount = 5000): string[] {
  const dates: string[] = [];
  for (let n = 0; n < maxCount; n++) {
    const date = nthOccurrence(spec, n);
    if (date > through) break;
    dates.push(date);
  }
  return dates;
}

// ── The range ("days to do it") ──────────────────────────────────────────────

export interface Window {
  start: string;
  end: string;
}

export function windowFor(expectedDate: string, beforeDays: number, afterDays: number): Window {
  return { start: addDays(expectedDate, -beforeDays), end: addDays(expectedDate, afterDays) };
}

export interface MaterializeOptions {
  today: string;
  /** How far ahead to generate occurrences (so upcoming ones show in the UI). */
  horizonDays?: number;
  /**
   * How long after a window closes an occurrence is still worth creating. A brand-new
   * item with an old anchor must not flood the table with months of history, but an
   * occurrence that closed a few days ago can still be matched by a transaction that
   * only just synced.
   */
  lookbackDays?: number;
}

export interface PlannedOccurrence {
  expectedDate: string;
  window: Window;
}

/** The occurrences that should exist right now for an item: recent, current and upcoming. */
export function plannedOccurrences(
  spec: CadenceSpec & { windowBeforeDays: number; windowAfterDays: number },
  { today, horizonDays = 45, lookbackDays = 7 }: MaterializeOptions
): PlannedOccurrence[] {
  const horizon = addDays(today, horizonDays);
  const earliestWindowEnd = addDays(today, -lookbackDays);
  // A window can open up to `windowBeforeDays` before its date, so look that far past the horizon.
  return occurrencesThrough(spec, addDays(horizon, spec.windowBeforeDays))
    .map((expectedDate) => ({ expectedDate, window: windowFor(expectedDate, spec.windowBeforeDays, spec.windowAfterDays) }))
    .filter((o) => o.window.end >= earliestWindowEnd && o.window.start <= horizon);
}

/** The next occurrence whose window hasn't closed yet (today counts), for the item's `nextExpectedDate`. */
export function nextExpectedDate(spec: CadenceSpec & { windowAfterDays: number }, today: string): string {
  for (let n = 0; n < 5000; n++) {
    const date = nthOccurrence(spec, n);
    if (addDays(date, spec.windowAfterDays) >= today) return date;
  }
  return nthOccurrence(spec, 0);
}

// ── The to-do an occurrence becomes ──────────────────────────────────────────

export const TODO_DUE_CHOICES = ["window_end", "expected_date"] as const;
export type TodoDue = (typeof TODO_DUE_CHOICES)[number];

/** Stored on recurring_items.todo_config (snake_case, like every other JSON this API exchanges). */
export interface TodoConfig {
  enabled: boolean;
  /** Days before the window opens to put the to-do on the list (0 = the day it opens). */
  lead_days: number;
  due: TodoDue;
  title_template: string;
  notes_template: string;
  category: string;
  priority: number;
}

export function defaultTodoConfig(expectedAmount: number | null): TodoConfig {
  return {
    enabled: true,
    lead_days: 0,
    due: "window_end",
    title_template: "{label}",
    notes_template: expectedAmount === null ? "Anytime {window}" : "About {amount} · anytime {window}",
    category: "finance",
    priority: 1,
  };
}

/** The closed set of placeholders a template may use. Anything else is rejected at save time. */
export const TEMPLATE_PLACEHOLDERS = ["label", "amount", "category", "expected_date", "window_start", "window_end", "window"] as const;
type Placeholder = (typeof TEMPLATE_PLACEHOLDERS)[number];

/** Returns an error message, or null if the template only uses known placeholders and balanced braces. */
export function validateTemplate(template: string, name: string, maxLength: number): string | null {
  if (template.length > maxLength) return `${name} must be at most ${maxLength} characters`;
  const allowed = TEMPLATE_PLACEHOLDERS as readonly string[];
  const unknown = (template.match(/\{([a-z_]+)\}/g) ?? []).map((m) => m.slice(1, -1)).find((key) => !allowed.includes(key));
  if (unknown) return `${name} uses an unknown placeholder {${unknown}} (allowed: ${TEMPLATE_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")})`;
  if (/[{}]/.test(template.replace(/\{([a-z_]+)\}/g, ""))) return `${name} has an unmatched brace`;
  return null;
}

export interface TodoContext {
  label: string;
  expectedAmount: number | null;
  category: string | null;
  expectedDate: string;
  window: Window;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(iso: string): string {
  const d = parseDate(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "Sep 1" for a one-day window, "Sep 1–5" within a month, "Sep 28 – Oct 2" across months. */
export function formatWindow(w: Window): string {
  if (w.start === w.end) return shortDate(w.start);
  const s = parseDate(w.start);
  const e = parseDate(w.end);
  return s.getUTCMonth() === e.getUTCMonth() && s.getUTCFullYear() === e.getUTCFullYear()
    ? `${shortDate(w.start)}–${e.getUTCDate()}`
    : `${shortDate(w.start)} – ${shortDate(w.end)}`;
}

export function formatAmount(amount: number | null): string {
  if (amount === null) return "";
  const text = `$${Math.abs(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return amount < 0 ? `+${text}` : text; // money in reads as "+$2,000.00", money out as "$1,800.00"
}

/** Fills a template. Plain substitution over a closed set -- never evaluates anything. */
export function renderTemplate(template: string, ctx: TodoContext): string {
  const values: Record<Placeholder, string> = {
    label: ctx.label,
    amount: formatAmount(ctx.expectedAmount),
    category: ctx.category ?? "",
    expected_date: ctx.expectedDate,
    window_start: ctx.window.start,
    window_end: ctx.window.end,
    window: formatWindow(ctx.window),
  };
  return template.replace(/\{([a-z_]+)\}/g, (whole, key: string) => (key in values ? values[key as Placeholder] : whole));
}

export interface RenderedTodo {
  title: string;
  notes: string | null;
  category: string;
  priority: number;
  due_at: string;
}

export function renderTodo(config: TodoConfig, ctx: TodoContext): RenderedTodo {
  const title = renderTemplate(config.title_template, ctx).replace(/\s+/g, " ").trim() || ctx.label;
  const notes = renderTemplate(config.notes_template, ctx).trim();
  const dueDate = config.due === "expected_date" ? ctx.expectedDate : ctx.window.end;
  return {
    title: title.slice(0, 200),
    notes: notes || null,
    category: config.category,
    priority: config.priority,
    due_at: `${dueDate}T23:59:59.000Z`, // end of that day, UTC -- the codebase's own day convention
  };
}

/** The day this occurrence's to-do should appear on the list. */
export function todoCreateDate(window: Window, config: TodoConfig): string {
  return addDays(window.start, -config.lead_days);
}

/** Deterministic, so a re-run can never create a second to-do for the same occurrence. */
export function todoSourceId(itemId: number, expectedDate: string): string {
  return `recurring-${itemId}-${expectedDate}`;
}

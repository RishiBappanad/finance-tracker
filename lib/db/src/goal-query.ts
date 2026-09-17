/**
 * Goal Query interpreter -- translates the JSONB `measure_query`/
 * `reference_query` shape (workspace-notes/RECURRING_AND_GOALS_SPEC.md's
 * "Goal Query -- the shared shape" section) into safe, parameterized
 * Drizzle queries against domain_events, and evaluates them.
 *
 * This is THE piece every other tracker's Goals implementation has to
 * replicate (in its own stack: nutrition-insights' sql_builder.py,
 * todo-tracker's sqlBuilder.ts) -- see that spec section before changing
 * anything here, since the contract (field names, allowed values,
 * semantics) is standardized across trackers even though each tracker's
 * own copy of this interpreter is not shared code (Tenet #1).
 *
 * Safety invariant (CLAUDE.md's "Composable, Sanitized SQL" pattern,
 * applied to a new caller): every `aggregation`/`field`/`operator` value
 * from a GoalQuery is checked against a strict allow-list (isValid*
 * below) before this module ever branches on it to build a query.
 * Filter *values* always become real Drizzle-bound parameters (via
 * eq/gt/inArray/the `sql` tag's own ${} interpolation) -- never
 * `sql.raw()`, never string-concatenated into query text.
 */
import { and, eq, ne, gt, gte, lt, lte, inArray, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { domainEvents } from "./schema/domain_events";

type Database = NodePgDatabase<typeof schema>;

// ── Types ────────────────────────────────────────────────────────────────

export const AGGREGATIONS = ["sum", "mean", "median", "min", "max", "count", "percentile"] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

export const FILTER_OPERATORS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains"] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export const DIRECT_FILTER_FIELDS = ["category", "event_type", "owner_type", "amount"] as const;
export type DirectFilterField = (typeof DIRECT_FILTER_FIELDS)[number];

export const TIME_WINDOW_KINDS = ["current_period", "trailing", "same_period_last_year", "fixed_range", "all_time"] as const;
export type TimeWindowKind = (typeof TIME_WINDOW_KINDS)[number];

export const GOAL_QUERY_PERIODS = ["daily", "weekly", "monthly"] as const;
export type GoalQueryPeriod = (typeof GOAL_QUERY_PERIODS)[number];

export interface FilterCondition {
  field: DirectFilterField | `metadata.${string}`;
  operator: FilterOperator;
  value: string | number | (string | number)[];
}

export interface TimeWindow {
  kind: TimeWindowKind;
  period?: GoalQueryPeriod; // required for current_period / trailing / same_period_last_year
  count?: number; // trailing: periods back. same_period_last_year: years back.
  start?: string; // fixed_range only, "YYYY-MM-DD"
  end?: string; // fixed_range only, "YYYY-MM-DD"
}

export interface GoalQuery {
  aggregation: Aggregation;
  percentile?: number; // required iff aggregation === 'percentile', 0-100
  filters: FilterCondition[];
  timeWindow: TimeWindow;
}

// ── Validation ───────────────────────────────────────────────────────────

const METADATA_FIELD_RE = /^metadata\.[A-Za-z0-9_]+$/;

export function isValidAggregation(value: unknown): value is Aggregation {
  return typeof value === "string" && (AGGREGATIONS as readonly string[]).includes(value);
}

export function isValidFilterOperator(value: unknown): value is FilterOperator {
  return typeof value === "string" && (FILTER_OPERATORS as readonly string[]).includes(value);
}

export function isValidFilterField(value: unknown): value is FilterCondition["field"] {
  if (typeof value !== "string") return false;
  return (DIRECT_FILTER_FIELDS as readonly string[]).includes(value) || METADATA_FIELD_RE.test(value);
}

export function isValidTimeWindowKind(value: unknown): value is TimeWindowKind {
  return typeof value === "string" && (TIME_WINDOW_KINDS as readonly string[]).includes(value);
}

export function isValidGoalQueryPeriod(value: unknown): value is GoalQueryPeriod {
  return typeof value === "string" && (GOAL_QUERY_PERIODS as readonly string[]).includes(value);
}

function isDateString(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Validates one FilterCondition, returning an error message or null. */
function validateFilter(filter: unknown, index: number): string | null {
  if (typeof filter !== "object" || filter === null) return `filters[${index}] must be an object`;
  const f = filter as Record<string, unknown>;
  if (!isValidFilterField(f.field)) return `filters[${index}].field must be one of: ${DIRECT_FILTER_FIELDS.join(", ")}, or metadata.<key>`;
  if (!isValidFilterOperator(f.operator)) return `filters[${index}].operator must be one of: ${FILTER_OPERATORS.join(", ")}`;
  if (f.operator === "in") {
    if (!Array.isArray(f.value) || f.value.length === 0) return `filters[${index}].value must be a non-empty array when operator is "in"`;
  } else if (typeof f.value !== "string" && typeof f.value !== "number") {
    return `filters[${index}].value must be a string or number`;
  }
  return null;
}

/** Validates one TimeWindow, returning an error message or null. */
function validateTimeWindow(tw: unknown): string | null {
  if (typeof tw !== "object" || tw === null) return "time_window must be an object";
  const w = tw as Record<string, unknown>;
  if (!isValidTimeWindowKind(w.kind)) return `time_window.kind must be one of: ${TIME_WINDOW_KINDS.join(", ")}`;

  if (w.kind === "current_period" || w.kind === "trailing" || w.kind === "same_period_last_year") {
    if (!isValidGoalQueryPeriod(w.period)) return `time_window.period must be one of: ${GOAL_QUERY_PERIODS.join(", ")} when kind is "${w.kind}"`;
  }
  if (w.kind === "trailing" || w.kind === "same_period_last_year") {
    if (typeof w.count !== "number" || w.count < 1 || !Number.isInteger(w.count)) return `time_window.count must be a positive integer when kind is "${w.kind}"`;
  }
  if (w.kind === "fixed_range") {
    if (!isDateString(w.start) || !isDateString(w.end)) return `time_window.start and time_window.end (YYYY-MM-DD) are required when kind is "fixed_range"`;
  }
  return null;
}

/** Full validation of a GoalQuery from untrusted JSON (a request body, or
 * a jsonb column read back). Returns the parsed query or an error string
 * naming the first problem -- never throws, matching this project's
 * convention for request validation (e.g. calendarValidation.ts). */
export function parseGoalQuery(value: unknown): GoalQuery | string {
  if (typeof value !== "object" || value === null) return "must be an object";
  const q = value as Record<string, unknown>;

  if (!isValidAggregation(q.aggregation)) return `aggregation must be one of: ${AGGREGATIONS.join(", ")}`;
  if (q.aggregation === "percentile") {
    if (typeof q.percentile !== "number" || q.percentile < 0 || q.percentile > 100) return "percentile is required (0-100) when aggregation is \"percentile\"";
  }
  if (!Array.isArray(q.filters)) return "filters must be an array";
  for (let i = 0; i < q.filters.length; i++) {
    const err = validateFilter(q.filters[i], i);
    if (err) return err;
  }
  const twErr = validateTimeWindow(q.timeWindow ?? (q as Record<string, unknown>).time_window);
  if (twErr) return twErr;

  const timeWindow = (q.timeWindow ?? (q as Record<string, unknown>).time_window) as TimeWindow;
  return {
    aggregation: q.aggregation,
    ...(q.aggregation === "percentile" ? { percentile: q.percentile as number } : {}),
    filters: q.filters as FilterCondition[],
    timeWindow,
  };
}

// ── Filter -> Drizzle condition translation ─────────────────────────────

/** A jsonb-cast extraction of one metadata key from domain_events'
 * text-typed metadataJson column, as TEXT. `key` is always a bound
 * parameter (via the sql tag's ${} interpolation), never concatenated
 * into the query text, even though it's already constrained by
 * METADATA_FIELD_RE before this is ever called. */
function metadataTextExpr(key: string): SQL {
  return sql`(${domainEvents.metadataJson}::jsonb ->> ${key})`;
}

function metadataNumericExpr(key: string): SQL {
  return sql`(${domainEvents.metadataJson}::jsonb ->> ${key})::numeric`;
}

const DIRECT_COLUMNS = {
  category: domainEvents.category,
  event_type: domainEvents.eventType,
  owner_type: domainEvents.ownerType,
  amount: domainEvents.amount,
} as const;

/** Translates one already-validated FilterCondition into a Drizzle SQL
 * condition. Numeric comparison operators (gt/gte/lt/lte) against a
 * metadata.<key> field cast that key's extracted text to numeric first;
 * against `amount` they compare the real numeric column directly.
 *
 * `column` is deliberately typed `any` here: it's either a real Drizzle
 * Column object (category/event_type/owner_type/amount) or a raw `SQL`
 * expression (a metadata.<key> extraction) depending on `filter.field`,
 * and Drizzle's own eq/ne/gt/gte/lt/lte/inArray helpers already accept
 * both at runtime -- the union typing gains nothing but friction here.
 * Safety comes from `filter.field`/`filter.operator` already having
 * passed isValidFilterField/isValidFilterOperator before this runs, not
 * from this function's own TS types. */
function buildFilterCondition(filter: FilterCondition): SQL {
  const isMetadata = filter.field.startsWith("metadata.");
  const key = isMetadata ? filter.field.slice("metadata.".length) : null;
  const isNumericOp = filter.operator === "gt" || filter.operator === "gte" || filter.operator === "lt" || filter.operator === "lte";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const column: any = isMetadata ? (isNumericOp ? metadataNumericExpr(key!) : metadataTextExpr(key!)) : DIRECT_COLUMNS[filter.field as DirectFilterField];

  switch (filter.operator) {
    case "eq":
      return eq(column, filter.value);
    case "ne":
      return ne(column, filter.value);
    case "gt":
      return gt(column, filter.value);
    case "gte":
      return gte(column, filter.value);
    case "lt":
      return lt(column, filter.value);
    case "lte":
      return lte(column, filter.value);
    case "in":
      return inArray(column, filter.value as (string | number)[]);
    case "contains":
      return sql`${column} ILIKE ${"%" + String(filter.value) + "%"}`;
  }
}

// ── Time window -> date ranges ──────────────────────────────────────────

export interface DateRange {
  from: Date;
  to: Date; // exclusive upper bound
  /** First-of-month "YYYY-MM-01" this range's month, for CPI lookup --
   * only meaningful when the range is exactly one calendar month
   * (period: 'monthly'); undefined otherwise (inflation adjustment is a
   * no-op at other granularities -- CPI is monthly data). */
  monthForCpi?: string;
}

function periodLengthMs(period: GoalQueryPeriod): number | null {
  if (period === "daily") return 24 * 60 * 60 * 1000;
  if (period === "weekly") return 7 * 24 * 60 * 60 * 1000;
  return null; // monthly has variable length, handled separately below
}

/** The single period range containing `now`, offset by `periodsBack`
 * whole periods (0 = the period `now` falls in). Daily/weekly are fixed-
 * length and computed by simple ms arithmetic; monthly is computed via
 * calendar month arithmetic (variable day count). */
function periodRange(period: GoalQueryPeriod, periodsBack: number, now: Date): DateRange {
  if (period === "monthly") {
    const monthIndex = now.getUTCMonth() - periodsBack;
    const from = new Date(Date.UTC(now.getUTCFullYear(), monthIndex, 1));
    const to = new Date(Date.UTC(now.getUTCFullYear(), monthIndex + 1, 1));
    return { from, to, monthForCpi: from.toISOString().slice(0, 10) };
  }

  const lengthMs = periodLengthMs(period)!;
  if (period === "daily") {
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - periodsBack * lengthMs + lengthMs);
    const from = new Date(to.getTime() - lengthMs);
    return { from, to };
  }
  // weekly -- week starts Sunday, matching goals-evaluation.ts's existing currentPeriodWindow convention
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - now.getUTCDay()));
  const to = new Date(weekStart.getTime() - periodsBack * lengthMs + lengthMs);
  const from = new Date(to.getTime() - lengthMs);
  return { from, to };
}

/** The same calendar period as `now`, `yearsBack` years earlier. Only
 * really meaningful at period: 'monthly' (per the spec) but implemented
 * generically via calendar-field subtraction for daily/weekly too. */
function samePeriodYearsAgo(period: GoalQueryPeriod, yearsBack: number, now: Date): DateRange {
  const shifted = new Date(now);
  shifted.setUTCFullYear(shifted.getUTCFullYear() - yearsBack);
  return periodRange(period, 0, shifted);
}

/** Resolves a TimeWindow into one or more concrete date ranges. Always
 * returns at least one range. `trailing`/`same_period_last_year` return
 * `count` ranges (one evaluate-then-average call per range, see
 * evaluateGoalQuery below); every other kind returns exactly one. */
export function resolveTimeWindow(tw: TimeWindow, now: Date = new Date()): DateRange[] {
  if (tw.kind === "current_period") return [periodRange(tw.period!, 0, now)];
  if (tw.kind === "trailing") {
    const ranges: DateRange[] = [];
    for (let i = 1; i <= tw.count!; i++) ranges.push(periodRange(tw.period!, i, now));
    return ranges;
  }
  if (tw.kind === "same_period_last_year") {
    const ranges: DateRange[] = [];
    for (let i = 1; i <= tw.count!; i++) ranges.push(samePeriodYearsAgo(tw.period!, i, now));
    return ranges;
  }
  if (tw.kind === "fixed_range") {
    const from = new Date(`${tw.start}T00:00:00.000Z`);
    const to = new Date(`${tw.end}T00:00:00.000Z`);
    to.setUTCDate(to.getUTCDate() + 1); // end is inclusive in the request, exclusive internally
    return [{ from, to }];
  }
  // all_time
  return [{ from: new Date(0), to: new Date(8_640_000_000_000_000) }];
}

// ── Aggregate execution ──────────────────────────────────────────────────

/** Runs one aggregation over one date range, for one user, with the
 * query's filters applied -- the only place that actually issues a SQL
 * query in this module. `excludeEventId`, when set, excludes that one
 * domain_events row -- used for the event-triggered "before" evaluation
 * (goals-evaluation.ts), which must compute what the aggregate would
 * have been without the just-inserted event. */
export async function computeAggregateForRange(
  db: Database,
  userId: number,
  query: Pick<GoalQuery, "aggregation" | "percentile" | "filters">,
  range: DateRange,
  excludeEventId?: number
): Promise<number> {
  const conditions = [
    eq(domainEvents.userId, userId),
    gte(domainEvents.occurredAt, range.from),
    lt(domainEvents.occurredAt, range.to),
    ...query.filters.map(buildFilterCondition),
  ];
  if (excludeEventId !== undefined) conditions.push(ne(domainEvents.id, excludeEventId));
  const where = and(...conditions);

  if (query.aggregation === "count") {
    const [row] = await db.select({ v: sql<string>`count(*)` }).from(domainEvents).where(where);
    return Number(row?.v ?? 0);
  }
  if (query.aggregation === "sum") {
    const [row] = await db.select({ v: sql<string>`coalesce(sum(${domainEvents.amount}), 0)` }).from(domainEvents).where(where);
    return Number(row?.v ?? 0);
  }
  if (query.aggregation === "mean") {
    const [row] = await db.select({ v: sql<string>`coalesce(avg(${domainEvents.amount}), 0)` }).from(domainEvents).where(where);
    return Number(row?.v ?? 0);
  }
  if (query.aggregation === "min") {
    const [row] = await db.select({ v: sql<string>`coalesce(min(${domainEvents.amount}), 0)` }).from(domainEvents).where(where);
    return Number(row?.v ?? 0);
  }
  if (query.aggregation === "max") {
    const [row] = await db.select({ v: sql<string>`coalesce(max(${domainEvents.amount}), 0)` }).from(domainEvents).where(where);
    return Number(row?.v ?? 0);
  }
  // median | percentile -- Postgres's percentile_cont(fraction) WITHIN GROUP,
  // fraction always a bound parameter, never string-built.
  const fraction = query.aggregation === "median" ? 0.5 : query.percentile! / 100;
  const [row] = await db
    .select({ v: sql<string>`coalesce(percentile_cont(${fraction}) within group (order by ${domainEvents.amount}), 0)` })
    .from(domainEvents)
    .where(where);
  return Number(row?.v ?? 0);
}

export interface EvaluatedQuery {
  value: number;
  ranges: DateRange[];
}

/** The full evaluation of one GoalQuery: resolves its time window into
 * one or more date ranges, computes the aggregation over each range
 * separately, and averages the per-range results together (a single-
 * range window's "average" is just that one value -- see
 * RECURRING_AND_GOALS_SPEC.md's "count > 1 averages across periods"
 * framing, which this generalizes uniformly to count === 1 and to
 * single-range kinds too, rather than special-casing "just one range"). */
export async function evaluateGoalQuery(
  db: Database,
  userId: number,
  query: GoalQuery,
  options: { now?: Date; excludeEventId?: number } = {}
): Promise<EvaluatedQuery> {
  const now = options.now ?? new Date();
  const ranges = resolveTimeWindow(query.timeWindow, now);
  const perRangeValues = await Promise.all(ranges.map((range) => computeAggregateForRange(db, userId, query, range, options.excludeEventId)));
  const value = perRangeValues.reduce((sum, v) => sum + v, 0) / perRangeValues.length;
  return { value: Math.round(value * 100) / 100, ranges };
}

/** A quick, in-process (not DB-indexed) check of whether an event with
 * the given category/eventType/ownerType could plausibly match a
 * GoalQuery's filters -- used to narrow "which of this user's goals does
 * this event affect" (goals-evaluation.ts) without literally re-running
 * every goal's full aggregation for every event. Conservative: only
 * eq/in filters on category/event_type/owner_type can rule a goal OUT;
 * every other filter shape (amount, metadata.*, ne, gt/gte/lt/lte,
 * contains) can't be cheaply pre-checked without querying, so a goal
 * with any such filter is always treated as a possible match. */
export function couldMatchEvent(query: GoalQuery, event: { category: string | null; eventType: string; ownerType: string }): boolean {
  const fieldValue: Record<DirectFilterField, string | null> = {
    category: event.category,
    event_type: event.eventType,
    owner_type: event.ownerType,
    amount: null, // never cheaply pre-checkable -- always a possible match
  };
  for (const filter of query.filters) {
    if (filter.operator !== "eq" && filter.operator !== "in") continue;
    if (filter.field === "amount" || filter.field.startsWith("metadata.")) continue;
    const actual = fieldValue[filter.field as DirectFilterField];
    if (filter.operator === "eq" && actual !== filter.value) return false;
    if (filter.operator === "in" && !(filter.value as (string | number)[]).includes(actual as string)) return false;
  }
  return true;
}

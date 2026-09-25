/**
 * TrackStack Universal Event Contract adapter -- as of 2026-09-15, backed
 * by the real `domain_events` log (see lib/db/src/domain-events.ts) rather
 * than deriving events live from bank_transactions' current rows. Mirrors
 * nutrition-insights' app/routers/events.py structurally (same
 * _query_events-shared-by-both-GET-endpoints pattern, same
 * occurred_at/logged_at split), not literally -- finance's real schema and
 * category model are different enough that this isn't a port.
 *
 * Deliberately an ADDITIONAL layer, not a replacement for
 * routes/transactions.ts, which stays exactly as it is and remains the
 * primary way this app's own frontend talks to its own backend --
 * routes/transactions.ts's own mutations now call logDomainEvent()
 * directly, the same way routes/receipts.ts, routes/matches.ts,
 * routes/accounts.ts, and routes/categories.ts already do.
 *
 * event_type is genuinely CRUD-based now ("transaction_created",
 * "receipt_updated", "user_category_deleted", ...) across every entity
 * this tracker owns, not just "transaction" -- the same rework
 * nutrition-insights did first (see EVENT_CONTRACT_SPEC.md's
 * Implementation Log). POST /events/log's own request contract still only
 * accepts event_type: "transaction" (the OpenAPI-generated LogEventBody
 * schema hasn't been regenerated for this rework -- a known follow-up,
 * not done here) -- internally it's dispatched as a "created" action, same
 * as before.
 */
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { db } from "@workspace/db";
import { bankTransactions, domainEvents, userCategories, logDomainEvent } from "@workspace/db";
import { eq, and, gte, lt, asc, sql, type SQL } from "drizzle-orm";
import { LogEventBody, GetEventsQueryParams, GetEventAggregationsQueryParams } from "@workspace/api-zod";
import { getOrCreateManualAccountId } from "../lib/manual-account.js";
import { buildContext, renderContextMarkdown } from "../lib/event-context.js";
import { CATEGORIES } from "../services/categorizer.js";

export const eventsRouter = Router();
export const aggregationsRouter = Router();

interface EventShape {
  id: string;
  user_id: number;
  // Entity identity (contracts/EVENT_CONTRACT_SPEC.md, "Entity identity"):
  // (owner_type, owner_id) is "one thing" across all of its create/update/
  // delete rows.
  owner_type: string;
  owner_id: string;
  event_type: string;
  category: string | null;
  occurred_at: string;
  created_at: string;
  amount: number;
  source: string | null;
  source_id: string | null;
  hidden: boolean;
  status: string | null;
  metadata: Record<string, unknown>;
  label: string | null;
}

function rowToEvent(r: typeof domainEvents.$inferSelect): EventShape {
  const metadata = JSON.parse(r.metadataJson) as Record<string, unknown>;
  return {
    id: String(r.id),
    user_id: r.userId,
    owner_type: r.ownerType,
    owner_id: r.ownerId,
    event_type: r.eventType,
    category: r.category,
    // occurred_at is the entity's own business date where one exists
    // (threaded through by each route's logDomainEvent() call) and
    // insert time otherwise; created_at is domain_events.loggedAt,
    // always real insert time -- the same split nutrition-insights'
    // domain_events table makes, for the same reason: a backdatable
    // entity (a transaction, a receipt) can genuinely have occurred_at
    // differ from when the row was actually written.
    occurred_at: r.occurredAt.toISOString(),
    created_at: r.loggedAt.toISOString(),
    amount: r.amount,
    source: r.source,
    source_id: r.sourceId,
    // No dedicated `hidden` column on domain_events (same as
    // nutrition-insights') -- transaction events carry it in
    // metadata.ignored (the one entity type here that has a real
    // "hidden" concept); everything else has none, so false.
    hidden: typeof metadata.ignored === "boolean" ? metadata.ignored : false,
    // `status` stays null for every event_type -- finance's real
    // lifecycle field (`pending`) is a boolean surfaced in
    // metadata.pending, not generalized into a string enum, per
    // EVENT_CONTRACT_SPEC.md's Resolved Decision #3.
    status: null,
    metadata,
    label: r.label,
  };
}

/** Shared by GET /events and GET /aggregations/{aggType}. occurred_at is a
 * real timestamptz, not a bare date, so `end` (inclusive) is turned into an
 * exclusive upper bound one day later rather than compared directly --
 * otherwise a row logged any time after midnight on the end date (true for
 * every event with no business date of its own, e.g. every receipt_item/
 * match/account/category event) would be wrongly excluded. Same fix
 * nutrition-insights' _query_events already needed for the identical
 * reason. */
interface EventQueryOptions {
  eventType?: string | null;
  source?: string | null;
  ownerType?: string | null;
  view?: "log" | "current";
}

type DomainEventRow = typeof domainEvents.$inferSelect;

/** db.execute() returns raw pg rows (snake_case columns), not Drizzle-typed
 * ones -- map back so rowToEvent stays the single place a row becomes an
 * EventShape. */
function rawRowToDomainEvent(r: Record<string, unknown>): DomainEventRow {
  return {
    id: r.id as number,
    userId: r.user_id as number,
    ownerType: r.owner_type as string,
    ownerId: r.owner_id as string,
    eventType: r.event_type as string,
    category: (r.category as string | null) ?? null,
    amount: r.amount as number,
    label: (r.label as string | null) ?? null,
    source: (r.source as string | null) ?? null,
    sourceId: (r.source_id as string | null) ?? null,
    metadataJson: r.metadata_json as string,
    occurredAt: r.occurred_at as Date,
    loggedAt: r.logged_at as Date,
  };
}

/** view=current, per contracts/EVENT_CONTRACT_SPEC.md "Definition of
 * current": one row per live entity in its latest state (create/update/
 * delete rows collapsed by (owner_type, owner_id), entities whose latest
 * row is a deletion dropped), plus every "occurrence" event (anything not
 * ending in a CRUD suffix, e.g. goal_met) unchanged. Filters are applied
 * AFTER the collapse, to each entity's current state -- so a transaction
 * recategorized out of a category is not found under its old one, and a
 * backdating edit moves an entity to its new date. Same collapse Goals'
 * currentStateCte (lib/db/src/goal-query.ts) implements. */
async function queryCurrentRows(userId: number, startDate: Date, endExclusive: Date, opts: EventQueryOptions): Promise<DomainEventRow[]> {
  const ownerFilter: SQL = opts.ownerType ? sql`AND owner_type = ${opts.ownerType}` : sql``;
  const sourceFilter: SQL = opts.source ? sql`AND source = ${opts.source}` : sql``;
  const result = await db.execute<Record<string, unknown>>(sql`
    WITH latest_state AS (
      SELECT DISTINCT ON (owner_type, owner_id) *
      FROM domain_events
      WHERE user_id = ${userId} AND event_type ~ '_(created|updated|deleted)$'
      ORDER BY owner_type, owner_id, logged_at DESC, id DESC
    ),
    current_events AS (
      SELECT * FROM latest_state WHERE event_type !~ '_deleted$'
      UNION ALL
      SELECT * FROM domain_events WHERE user_id = ${userId} AND event_type !~ '_(created|updated|deleted)$'
    )
    SELECT * FROM current_events
    WHERE occurred_at >= ${startDate} AND occurred_at < ${endExclusive} ${ownerFilter} ${sourceFilter}
    ORDER BY occurred_at ASC, id ASC
  `);
  return result.rows.map(rawRowToDomainEvent);
}

async function queryEvents(userId: number, start: string, end: string, opts: EventQueryOptions = {}): Promise<EventShape[]> {
  const startDate = new Date(`${start}T00:00:00.000Z`);
  const endExclusive = new Date(`${end}T00:00:00.000Z`);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);

  if (opts.view === "current") {
    return (await queryCurrentRows(userId, startDate, endExclusive, opts)).map(rowToEvent);
  }

  const conditions = [eq(domainEvents.userId, userId), gte(domainEvents.occurredAt, startDate), lt(domainEvents.occurredAt, endExclusive)];
  if (opts.eventType) conditions.push(eq(domainEvents.eventType, opts.eventType));
  if (opts.source) conditions.push(eq(domainEvents.source, opts.source));
  if (opts.ownerType) conditions.push(eq(domainEvents.ownerType, opts.ownerType));

  const rows = await db
    .select()
    .from(domainEvents)
    .where(and(...conditions))
    .orderBy(asc(domainEvents.occurredAt), asc(domainEvents.id));

  return rows.map(rowToEvent);
}

eventsRouter.post("/log", async (req, res) => {
  const parsed = LogEventBody.safeParse(req.body);
  if (!parsed.success) {
    return void res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
  }
  const body = parsed.data;

  if (body.event_type !== "transaction") {
    return void res.status(400).json({ error: `unknown event_type "${body.event_type}" -- must be "transaction"` });
  }

  const userId = req.user!.userId;
  const accountId = await getOrCreateManualAccountId(userId);
  const metadata = (body.metadata ?? {}) as Record<string, unknown>;
  const merchantName = typeof metadata.merchantName === "string" ? metadata.merchantName : null;
  const merchantNameRaw = typeof metadata.merchantNameRaw === "string" ? metadata.merchantNameRaw : null;
  const currency = typeof metadata.currency === "string" ? metadata.currency : "USD";

  const [inserted] = await db
    .insert(bankTransactions)
    .values({
      id: randomUUID(),
      accountId,
      amount: body.amount ?? 0,
      currency,
      merchantName,
      merchantNameRaw,
      userCategory: body.category ?? null,
      ignored: body.hidden ?? false,
      date: body.occurred_at,
      pending: false,
      source: body.source ?? "manual",
      sourceId: body.source_id ?? null,
    })
    .returning();

  await logDomainEvent(db, {
    userId, ownerType: "transaction", ownerId: inserted!.id, action: "created",
    category: inserted!.userCategory, amount: inserted!.amount,
    label: merchantName ?? merchantNameRaw, source: inserted!.source, sourceId: inserted!.sourceId,
    metadata: { merchantName, merchantNameRaw, currency, pending: false, ignored: inserted!.ignored },
    occurredAt: new Date(inserted!.date),
  });

  res.json({ status: "logged", id: inserted!.id });
});

const DEFAULT_AGGREGATION_OWNER_TYPE = "transaction";
const VIEWS = ["log", "current"] as const;
type View = (typeof VIEWS)[number];

/** `view` and `owner_type` are read straight off req.query rather than
 * through the generated GetEventsQueryParams -- that schema is
 * OpenAPI-generated and hasn't been regenerated for these additions (the
 * same known follow-up POST /events/log's own top comment mentions). */
function parseView(raw: unknown): View | null {
  if (raw === undefined) return "log";
  return typeof raw === "string" && (VIEWS as readonly string[]).includes(raw) ? (raw as View) : null;
}

function optionalString(raw: unknown): string | null {
  return typeof raw === "string" && raw !== "" ? raw : null;
}

eventsRouter.get("/", async (req, res) => {
  const parsed = GetEventsQueryParams.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid query params", details: parsed.error.issues });
  const { start, end, event_type, source } = parsed.data;

  const view = parseView(req.query.view);
  if (view === null) return void res.status(400).json({ error: `view must be one of: ${VIEWS.join(", ")}` });
  // Once rows are collapsed to one per entity, "latest action" (the
  // event_type of whichever row happened to win) is no longer something a
  // caller can meaningfully filter on -- owner_type is the filter that
  // means "what kind of thing". See EVENT_CONTRACT_SPEC.md.
  if (view === "current" && event_type) {
    return void res.status(400).json({ error: "event_type cannot be combined with view=current; filter by owner_type instead" });
  }

  // No fixed event_type whitelist here (unlike the old single-type check)
  // -- every event_type value lives in the same domain_events table now,
  // so an unrecognized value is just a WHERE clause that matches nothing,
  // not an error. Matches nutrition-insights' identical post-rework
  // behavior.
  const events = await queryEvents(req.user!.userId, start, end, {
    eventType: event_type ?? null,
    source,
    ownerType: optionalString(req.query.owner_type),
    view,
  });
  res.json({ events, total: events.length });
});

eventsRouter.get("/context", async (req, res) => {
  const custom = await db
    .select({ name: userCategories.name })
    .from(userCategories)
    .where(eq(userCategories.userId, req.user!.userId))
    .orderBy(userCategories.name);
  const ctx = buildContext(CATEGORIES, custom.map((c) => c.name));
  if (req.query.format === "markdown") {
    return void res.type("text/markdown").send(renderContextMarkdown(ctx));
  }
  res.json(ctx);
});

aggregationsRouter.get("/:aggType", async (req, res) => {
  const aggType = req.params.aggType;
  if (aggType !== "by_category" && aggType !== "by_source" && aggType !== "by_event_type") {
    return void res.status(400).json({ error: "aggType must be one of: by_category, by_source, by_event_type" });
  }

  const parsed = GetEventAggregationsQueryParams.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid query params", details: parsed.error.issues });
  const { start, end } = parsed.data;

  // Aggregations sum over CURRENT state (an edited transaction counts
  // once, a deleted one not at all) and, by default, over transactions
  // only: `amount` is dollars for a transaction, but a receipt's total, a
  // line item's price and a match's amount are different quantities about
  // the same purchases, so summing across owner types double-counts
  // spending. See lib/event-context.ts (`summable`).
  const events = await queryEvents(req.user!.userId, start, end, {
    view: "current",
    ownerType: optionalString(req.query.owner_type) ?? DEFAULT_AGGREGATION_OWNER_TYPE,
  });

  const keyFn: Record<string, (e: EventShape) => string> = {
    by_category: (e) => e.category ?? "uncategorized",
    by_source: (e) => e.source ?? "unknown",
    by_event_type: (e) => e.event_type,
  };
  const groupKey = aggType.replace("by_", ""); // "category" | "source" | "event_type"

  const totals = new Map<string, number>();
  for (const e of events) {
    const key = keyFn[aggType]!(e);
    totals.set(key, (totals.get(key) ?? 0) + (e.amount || 0));
  }

  const data = [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, total]) => ({ [groupKey]: key, total_amount: Math.round(total * 100) / 100, unit: "usd" }));

  res.json({ data });
});

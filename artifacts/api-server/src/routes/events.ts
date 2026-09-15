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
import { bankTransactions, domainEvents, logDomainEvent } from "@workspace/db";
import { eq, and, gte, lt, asc } from "drizzle-orm";
import { LogEventBody, GetEventsQueryParams, GetEventAggregationsQueryParams } from "@workspace/api-zod";
import { getOrCreateManualAccountId } from "../lib/manual-account.js";

export const eventsRouter = Router();
export const aggregationsRouter = Router();

interface EventShape {
  id: string;
  user_id: number;
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
async function queryEvents(userId: number, start: string, end: string, eventType?: string | null, source?: string | null): Promise<EventShape[]> {
  const startDate = new Date(`${start}T00:00:00.000Z`);
  const endExclusive = new Date(`${end}T00:00:00.000Z`);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);

  const conditions = [eq(domainEvents.userId, userId), gte(domainEvents.occurredAt, startDate), lt(domainEvents.occurredAt, endExclusive)];
  if (eventType) conditions.push(eq(domainEvents.eventType, eventType));
  if (source) conditions.push(eq(domainEvents.source, source));

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

eventsRouter.get("/", async (req, res) => {
  const parsed = GetEventsQueryParams.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid query params", details: parsed.error.issues });
  const { start, end, event_type, source } = parsed.data;

  // No fixed event_type whitelist here (unlike the old single-type check)
  // -- every event_type value lives in the same domain_events table now,
  // so an unrecognized value is just a WHERE clause that matches nothing,
  // not an error. Matches nutrition-insights' identical post-rework
  // behavior.
  const events = await queryEvents(req.user!.userId, start, end, event_type ?? null, source);
  res.json({ events, total: events.length });
});

aggregationsRouter.get("/:aggType", async (req, res) => {
  const aggType = req.params.aggType;
  if (aggType !== "by_category" && aggType !== "by_source" && aggType !== "by_event_type") {
    return void res.status(400).json({ error: "aggType must be one of: by_category, by_source, by_event_type" });
  }

  const parsed = GetEventAggregationsQueryParams.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid query params", details: parsed.error.issues });
  const { start, end } = parsed.data;

  const events = await queryEvents(req.user!.userId, start, end);

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

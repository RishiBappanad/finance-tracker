/**
 * TrackStack Universal Event Contract adapter -- translates this
 * tracker's real domain table (bank_transactions) into the Core Event
 * Shape (see workspace-notes/EVENT_CONTRACT_SPEC.md) and back. Mirrors
 * nutrition-insights' app/routers/events.py structurally (same three
 * routes, same _query_events-shared-by-both-GET-endpoints pattern), not
 * literally -- finance's real schema and category model are different
 * enough that this isn't a port.
 *
 * Deliberately an ADDITIONAL layer, not a replacement for
 * routes/transactions.ts, which stays exactly as it is and remains the
 * primary way this app's own frontend talks to its own backend.
 *
 * finance has exactly one event_type ("transaction") -- unlike
 * nutrition's two (food_entry/exercise_activity), there's no dispatch
 * table needed here, just a single-type check.
 */
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { db } from "@workspace/db";
import { bankTransactions, joinTransactionOwnership, ownedByUser } from "@workspace/db";
import { eq, and, gte, lte } from "drizzle-orm";
import { LogEventBody, GetEventsQueryParams, GetEventAggregationsQueryParams } from "@workspace/api-zod";
import { getOrCreateManualAccountId } from "../lib/manual-account.js";

export const eventsRouter = Router();
export const aggregationsRouter = Router();

interface EventShape {
  id: string;
  user_id: number;
  event_type: "transaction";
  category: string | null;
  occurred_at: string;
  created_at: string;
  amount: number;
  source: string | null;
  source_id: string | null;
  hidden: boolean;
  status: string | null;
  metadata: Record<string, unknown>;
}

type TxnRow = {
  id: string;
  amount: number;
  currency: string;
  merchantName: string | null;
  merchantNameRaw: string | null;
  categoryPrimary: string | null;
  userCategory: string | null;
  ignored: boolean;
  date: string;
  pending: boolean;
  source: string;
  sourceId: string | null;
  createdAt: Date;
};

function transactionToEvent(t: TxnRow, userId: number): EventShape {
  return {
    id: t.id,
    user_id: userId,
    event_type: "transaction",
    // userCategory (the user's own override) wins over Plaid's own
    // categoryPrimary -- same "user override wins" convention every
    // other category-reading path in this app already follows (see
    // routes/transactions.ts's serializeTxn).
    category: t.userCategory ?? t.categoryPrimary ?? null,
    occurred_at: t.date,
    created_at: t.createdAt.toISOString(),
    amount: t.amount,
    source: t.source,
    source_id: t.sourceId,
    // Maps directly to `ignored` -- same concept, per
    // EVENT_CONTRACT_SPEC.md.
    hidden: t.ignored,
    // `status` (a string lifecycle field) has no real finance
    // equivalent -- `pending` is a boolean, not a string enum, and
    // stays that way per EVENT_CONTRACT_SPEC.md's Resolved Decision #3.
    // Surfaced via metadata.pending instead of forcing it into a field
    // shape it doesn't fit.
    status: null,
    metadata: {
      merchantName: t.merchantName,
      merchantNameRaw: t.merchantNameRaw,
      currency: t.currency,
      pending: t.pending,
    },
  };
}

/** Shared by GET /events and GET /aggregations/{aggType} -- both need
 * the exact same ownership-scoped, date-ranged event set, so aggregation
 * reuses this instead of querying bank_transactions a second,
 * differently-shaped way (which is exactly how GET /events and an
 * aggregation endpoint could silently disagree about what "an event"
 * is). */
async function queryEvents(userId: number, start: string, end: string, source?: string | null): Promise<EventShape[]> {
  const conditions = [ownedByUser(userId), gte(bankTransactions.date, start), lte(bankTransactions.date, end)];
  if (source) conditions.push(eq(bankTransactions.source, source));

  const rows = await joinTransactionOwnership(db
    .select({
      id: bankTransactions.id,
      amount: bankTransactions.amount,
      currency: bankTransactions.currency,
      merchantName: bankTransactions.merchantName,
      merchantNameRaw: bankTransactions.merchantNameRaw,
      categoryPrimary: bankTransactions.categoryPrimary,
      userCategory: bankTransactions.userCategory,
      ignored: bankTransactions.ignored,
      date: bankTransactions.date,
      pending: bankTransactions.pending,
      source: bankTransactions.source,
      sourceId: bankTransactions.sourceId,
      createdAt: bankTransactions.createdAt,
    })
    .from(bankTransactions).$dynamic())
    .where(and(...conditions))
    .orderBy(bankTransactions.date, bankTransactions.id);

  return rows.map((r) => transactionToEvent(r, userId));
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

  const [inserted] = await db
    .insert(bankTransactions)
    .values({
      id: randomUUID(),
      accountId,
      amount: body.amount ?? 0,
      currency: typeof metadata.currency === "string" ? metadata.currency : "USD",
      merchantName: typeof metadata.merchantName === "string" ? metadata.merchantName : null,
      merchantNameRaw: typeof metadata.merchantNameRaw === "string" ? metadata.merchantNameRaw : null,
      userCategory: body.category ?? null,
      ignored: body.hidden ?? false,
      date: body.occurred_at,
      pending: false,
      source: body.source ?? "manual",
      sourceId: body.source_id ?? null,
    })
    .returning({ id: bankTransactions.id });

  res.json({ status: "logged", id: inserted!.id });
});

eventsRouter.get("/", async (req, res) => {
  const parsed = GetEventsQueryParams.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid query params", details: parsed.error.issues });
  const { start, end, event_type, source } = parsed.data;

  if (event_type && event_type !== "transaction") {
    return void res.status(400).json({ error: `unknown event_type ${event_type} -- must be "transaction"` });
  }

  const events = await queryEvents(req.user!.userId, start, end, source);
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

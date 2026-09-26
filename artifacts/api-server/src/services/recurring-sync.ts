/**
 * The scheduled half of recurring items -- what POST /actions/sync-recurring/run
 * runs (routes/actions.ts). Four steps, each independent so one failing (Plaid
 * down, todo-tracker down) never stops the others:
 *
 *   1. plaid     fetch Plaid's own recurring streams and file NEW ones as unconfirmed
 *                suggestions (a person accepts or dismisses them).
 *   2. occurrences  make sure each active item has its recent/current/upcoming
 *                occurrences (the "expected" rows), idempotently.
 *   3. match     pair pending occurrences with the real bank transactions that
 *                satisfied them; flip ones whose window closed with nothing to `missed`.
 *   4. todos     hand each occurrence to todo-tracker ONCE when its create date
 *                arrives, and close the to-do when the occurrence gets matched.
 *
 * Safe to call repeatedly and concurrently (per the Actions contract): occurrences
 * are unique on (item, expected_date), a to-do has a deterministic source id and is
 * only sent while `todo_id` is still null, and matching only ever moves `pending` on.
 */
import {
  db,
  recurringItems,
  recurringItemOccurrences,
  bankTransactions,
  institutions,
  joinTransactionOwnership,
  ownedByUser,
  logDomainEvent,
  type RecurringItem,
} from "@workspace/db";
import { and, eq, gte, isNull, isNotNull, lte } from "drizzle-orm";
import {
  addDays,
  nextExpectedDate,
  plannedOccurrences,
  renderTodo,
  todoCreateDate,
  todoSourceId,
  type CadenceSpec,
} from "../lib/recurrence.js";
import { parseTodoConfig } from "../lib/recurring-validation.js";
import { mapStreamToSuggestion } from "../lib/recurring-plaid.js";
import { bestMatch, POSTING_SLACK_DAYS } from "./recurring-matcher.js";
import { scoreMerchant } from "./reconciler.js";
import type { PlaidAdapter } from "./plaid.js";
import type { TodoClient } from "./todo-client.js";

/** The most to-dos handed to todo-tracker in one run -- a backlog drains over successive runs instead of one long request. */
const MAX_TODOS_PER_RUN = 50;

export function specOf(item: RecurringItem): CadenceSpec & { windowBeforeDays: number; windowAfterDays: number } {
  return {
    cadence: item.cadence as CadenceSpec["cadence"],
    anchorDate: item.anchorDate,
    intervalDays: item.intervalDays,
    windowBeforeDays: item.windowBeforeDays,
    windowAfterDays: item.windowAfterDays,
  };
}

// ── 2. occurrences ──────────────────────────────────────────────────────────

export async function materializeOccurrences(userId: number, today: string): Promise<{ created: number; items: number }> {
  const items = await db
    .select()
    .from(recurringItems)
    .where(and(eq(recurringItems.userId, userId), eq(recurringItems.isActive, true), eq(recurringItems.confirmed, true)));

  let created = 0;
  for (const item of items) {
    const planned = plannedOccurrences(specOf(item), { today });
    if (planned.length > 0) {
      const inserted = await db
        .insert(recurringItemOccurrences)
        .values(planned.map((p) => ({ recurringItemId: item.id, expectedDate: p.expectedDate, windowStart: p.window.start, windowEnd: p.window.end })))
        .onConflictDoNothing()
        .returning({ id: recurringItemOccurrences.id });
      created += inserted.length;
    }
    const next = nextExpectedDate(specOf(item), today);
    if (next !== item.nextExpectedDate) await db.update(recurringItems).set({ nextExpectedDate: next }).where(eq(recurringItems.id, item.id));
  }
  return { created, items: items.length };
}

// ── 3. match ────────────────────────────────────────────────────────────────

export async function matchOccurrences(userId: number, today: string): Promise<{ matched: number; missed: number }> {
  const pending = await db
    .select({ occ: recurringItemOccurrences, item: recurringItems })
    .from(recurringItemOccurrences)
    .innerJoin(recurringItems, eq(recurringItemOccurrences.recurringItemId, recurringItems.id))
    .where(
      and(
        eq(recurringItems.userId, userId),
        eq(recurringItems.isActive, true),
        eq(recurringItems.confirmed, true),
        eq(recurringItemOccurrences.status, "pending"),
        lte(recurringItemOccurrences.windowStart, addDays(today, POSTING_SLACK_DAYS))
      )
    )
    .orderBy(recurringItemOccurrences.expectedDate);
  if (pending.length === 0) return { matched: 0, missed: 0 };

  // A transaction can satisfy only one occurrence, across ALL of this user's items.
  const claimedRows = await db
    .select({ id: recurringItemOccurrences.matchedOwnerId })
    .from(recurringItemOccurrences)
    .innerJoin(recurringItems, eq(recurringItemOccurrences.recurringItemId, recurringItems.id))
    .where(and(eq(recurringItems.userId, userId), eq(recurringItemOccurrences.matchedOwnerType, "transaction"), isNotNull(recurringItemOccurrences.matchedOwnerId)));
  const claimed = new Set(claimedRows.map((r) => r.id as string));

  let matched = 0;
  let missed = 0;
  for (const { occ, item } of pending) {
    const window = { start: occ.windowStart, end: occ.windowEnd };
    const rows = await joinTransactionOwnership(
      db
        .select({ id: bankTransactions.id, amount: bankTransactions.amount, date: bankTransactions.date, merchantName: bankTransactions.merchantName, merchantNameRaw: bankTransactions.merchantNameRaw })
        .from(bankTransactions)
        .$dynamic()
    ).where(
      and(
        ownedByUser(userId),
        eq(bankTransactions.ignored, false),
        eq(bankTransactions.pending, false), // a pending charge's id changes when it posts
        gte(bankTransactions.date, addDays(window.start, -POSTING_SLACK_DAYS)),
        lte(bankTransactions.date, addDays(window.end, POSTING_SLACK_DAYS))
      )
    );

    const best = bestMatch(
      { expectedAmount: item.expectedAmount, merchantHint: item.merchantHint ?? item.label, window },
      rows.filter((t) => !claimed.has(t.id)).map((t) => ({ id: t.id, amount: t.amount, date: t.date, merchantName: t.merchantName ?? t.merchantNameRaw ?? null }))
    );

    if (best) {
      claimed.add(best.transaction.id);
      await db
        .update(recurringItemOccurrences)
        .set({ status: "matched", matchedOwnerType: "transaction", matchedOwnerId: best.transaction.id, matchedAt: new Date(), matchScore: best.composite })
        .where(and(eq(recurringItemOccurrences.id, occ.id), eq(recurringItemOccurrences.status, "pending"))); // never overwrite a concurrent run's result
      matched++;
    } else if (addDays(window.end, POSTING_SLACK_DAYS) < today) {
      await db
        .update(recurringItemOccurrences)
        .set({ status: "missed" })
        .where(and(eq(recurringItemOccurrences.id, occ.id), eq(recurringItemOccurrences.status, "pending")));
      missed++;
    }
  }
  return { matched, missed };
}

// ── 4. todos ────────────────────────────────────────────────────────────────

export interface TodoSyncSummary {
  created: number;
  completed: number;
  failed: number;
  skippedReason?: string;
}

export async function syncTodos(userId: number, today: string, client: TodoClient | null, skippedReasonIfNoClient: string): Promise<TodoSyncSummary> {
  const scope = and(eq(recurringItems.userId, userId), eq(recurringItems.isActive, true), eq(recurringItems.confirmed, true));

  const toCreate = await db
    .select({ occ: recurringItemOccurrences, item: recurringItems })
    .from(recurringItemOccurrences)
    .innerJoin(recurringItems, eq(recurringItemOccurrences.recurringItemId, recurringItems.id))
    .where(and(scope, eq(recurringItemOccurrences.status, "pending"), isNull(recurringItemOccurrences.todoId), isNotNull(recurringItems.todoConfig), lte(recurringItemOccurrences.windowStart, addDays(today, 60)), gte(recurringItemOccurrences.windowEnd, today)))
    .orderBy(recurringItemOccurrences.windowStart);

  const due = toCreate
    .map(({ occ, item }) => ({ occ, item, config: parseTodoConfig(item.todoConfig, item.expectedAmount) }))
    .filter((r): r is typeof r & { config: Exclude<typeof r.config, string | null> } => r.config !== null && typeof r.config !== "string" && r.config.enabled)
    .filter((r) => todoCreateDate({ start: r.occ.windowStart, end: r.occ.windowEnd }, r.config) <= today)
    .slice(0, MAX_TODOS_PER_RUN);

  const toClose = await db
    .select({ occ: recurringItemOccurrences })
    .from(recurringItemOccurrences)
    .innerJoin(recurringItems, eq(recurringItemOccurrences.recurringItemId, recurringItems.id))
    .where(and(scope, eq(recurringItemOccurrences.status, "matched"), isNotNull(recurringItemOccurrences.todoId), isNull(recurringItemOccurrences.todoClosedAt)))
    .limit(MAX_TODOS_PER_RUN);

  const summary: TodoSyncSummary = { created: 0, completed: 0, failed: 0 };
  if (due.length === 0 && toClose.length === 0) return summary;
  if (!client) return { ...summary, skippedReason: skippedReasonIfNoClient };

  for (const { occ, item, config } of due) {
    const window = { start: occ.windowStart, end: occ.windowEnd };
    const todo = renderTodo(config, { label: item.label, expectedAmount: item.expectedAmount, category: item.category, expectedDate: occ.expectedDate, window });
    const result = await client.upsertBySource("finance", todoSourceId(item.id, occ.expectedDate), todo);
    if (result.ok) {
      // Recorded so it's sent exactly once: todo-tracker's upsert overwrites a person's edits on every call.
      await db.update(recurringItemOccurrences).set({ todoId: result.id, todoSyncedAt: new Date(), todoError: null }).where(eq(recurringItemOccurrences.id, occ.id));
      summary.created++;
    } else {
      await db.update(recurringItemOccurrences).set({ todoError: result.error }).where(eq(recurringItemOccurrences.id, occ.id));
      summary.failed++;
    }
  }

  for (const { occ } of toClose) {
    const result = await client.markDone(occ.todoId!);
    if (result.ok) {
      await db.update(recurringItemOccurrences).set({ todoClosedAt: new Date(), todoError: null }).where(eq(recurringItemOccurrences.id, occ.id));
      summary.completed++;
    } else {
      await db.update(recurringItemOccurrences).set({ todoError: result.error }).where(eq(recurringItemOccurrences.id, occ.id));
      summary.failed++;
    }
  }
  return summary;
}

// ── 1. plaid ────────────────────────────────────────────────────────────────

export interface PlaidSyncSummary {
  suggested: number;
  updated: number;
  error?: string;
}

export async function syncPlaidSuggestions(userId: number, today: string, adapter: PlaidAdapter): Promise<PlaidSyncSummary> {
  const linked = await db.select({ token: institutions.plaidAccessToken }).from(institutions).where(and(eq(institutions.userId, userId), isNotNull(institutions.plaidAccessToken)));
  const summary: PlaidSyncSummary = { suggested: 0, updated: 0 };
  if (linked.length === 0) return summary;

  const existing = await db.select().from(recurringItems).where(eq(recurringItems.userId, userId));
  const bySourceId = new Map(existing.filter((i) => i.source === "plaid" && i.sourceId).map((i) => [i.sourceId as string, i]));
  const handMade = existing.filter((i) => i.source !== "plaid" && i.isActive);

  for (const { token } of linked) {
    let streams;
    try {
      streams = await adapter.getRecurringStreams(token!);
    } catch (e: any) {
      summary.error = e?.message ?? "Plaid recurring fetch failed"; // one bad institution shouldn't hide the rest
      continue;
    }
    for (const stream of streams) {
      const suggestion = mapStreamToSuggestion(stream);
      if (!suggestion) continue;
      const spec = { cadence: suggestion.cadence, anchorDate: suggestion.anchorDate, windowAfterDays: suggestion.windowAfterDays };
      const known = bySourceId.get(suggestion.sourceId);

      if (known) {
        // Only refresh a suggestion nobody has acted on. A confirmed item is the person's now; a dismissed one stays dismissed.
        if (known.confirmed || !known.isActive) continue;
        const next = nextExpectedDate(spec, today);
        if (known.expectedAmount !== suggestion.expectedAmount || known.anchorDate !== suggestion.anchorDate || known.cadence !== suggestion.cadence || known.nextExpectedDate !== next) {
          await db.update(recurringItems).set({ expectedAmount: suggestion.expectedAmount, anchorDate: suggestion.anchorDate, cadence: suggestion.cadence, nextExpectedDate: next, updatedAt: new Date() }).where(eq(recurringItems.id, known.id));
          summary.updated++;
        }
        continue;
      }

      // Don't suggest what the person already tracks by hand.
      const duplicatesHandMade = handMade.some((i) => i.cadence === suggestion.cadence && scoreMerchant(i.merchantHint ?? i.label, suggestion.merchantHint) >= 0.85);
      if (duplicatesHandMade) continue;

      const [created] = await db
        .insert(recurringItems)
        .values({
          userId,
          label: suggestion.label,
          merchantHint: suggestion.merchantHint,
          expectedAmount: suggestion.expectedAmount,
          cadence: suggestion.cadence,
          anchorDate: suggestion.anchorDate,
          nextExpectedDate: nextExpectedDate(spec, today),
          windowBeforeDays: suggestion.windowBeforeDays,
          windowAfterDays: suggestion.windowAfterDays,
          source: "plaid",
          sourceId: suggestion.sourceId,
          confirmed: false,
        })
        .onConflictDoNothing() // (user, source, source_id): a concurrent run got there first
        .returning();
      if (created) {
        bySourceId.set(suggestion.sourceId, created);
        summary.suggested++;
        await logDomainEvent(db, { userId, ownerType: "recurring_item", ownerId: String(created.id), action: "created", label: created.label, source: "plaid", sourceId: suggestion.sourceId, metadata: { expected_amount: created.expectedAmount, cadence: created.cadence, confirmed: false } });
      }
    }
  }
  return summary;
}

// ── the whole run ───────────────────────────────────────────────────────────

export interface RecurringSyncOptions {
  today: string;
  /** null when finance-tracker has no todo-tracker to talk to (no TODO_API_URL, or no credential to forward). */
  todoClient: TodoClient | null;
  noTodoClientReason: string;
  plaid: PlaidAdapter;
}

export interface RecurringSyncSummary {
  plaid: PlaidSyncSummary;
  occurrences: { created: number; items: number };
  matched: number;
  missed: number;
  todos: TodoSyncSummary;
  errors: string[];
}

export async function runRecurringSync(userId: number, opts: RecurringSyncOptions): Promise<RecurringSyncSummary> {
  const summary: RecurringSyncSummary = {
    plaid: { suggested: 0, updated: 0 },
    occurrences: { created: 0, items: 0 },
    matched: 0,
    missed: 0,
    todos: { created: 0, completed: 0, failed: 0 },
    errors: [],
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e: any) {
      summary.errors.push(`${name}: ${e?.message ?? e}`);
    }
  };

  await step("plaid", async () => { summary.plaid = await syncPlaidSuggestions(userId, opts.today, opts.plaid); });
  await step("occurrences", async () => { summary.occurrences = await materializeOccurrences(userId, opts.today); });
  await step("match", async () => { Object.assign(summary, await matchOccurrences(userId, opts.today)); });
  await step("todos", async () => { summary.todos = await syncTodos(userId, opts.today, opts.todoClient, opts.noTodoClientReason); });
  return summary;
}

/**
 * Recurring items -- forecasts of "what's expected to happen" (a bill, a
 * paycheck, a chore) with a range of days to do it in and an optional to-do
 * that appears for each occurrence. Design and decisions:
 * workspace-notes/RECURRING_AND_GOALS_SPEC.md, "Recurring Items".
 *
 * These are per-tracker tables, deliberately NOT domain_events rows (a forecast
 * isn't a fact). Creating/editing/deleting an item itself is a fact and is logged
 * as a `recurring_item_*` event with amount 0 -- the expected amount rides in
 * metadata -- so a forecast can never inflate a spend goal (goals sum `amount`).
 * Occurrence states (pending/matched/missed) are informational and not events.
 */
import { Router } from "express";
import { db, recurringItems, recurringItemOccurrences, logDomainEvent, type RecurringItem, type RecurringItemOccurrence } from "@workspace/db";
import { and, desc, eq, inArray, isNull, gte } from "drizzle-orm";
import { addDays, nextExpectedDate, renderTodo, todayUtc, windowFor, isDateString } from "../lib/recurrence.js";
import { checkItemConsistency, parseItemFields, parseTodoConfig, type ItemFields } from "../lib/recurring-validation.js";
import { materializeOccurrences } from "../services/recurring-sync.js";

const router = Router();

function serializeOccurrence(o: RecurringItemOccurrence) {
  return {
    id: o.id,
    expected_date: o.expectedDate,
    window_start: o.windowStart,
    window_end: o.windowEnd,
    status: o.status,
    matched_transaction_id: o.matchedOwnerType === "transaction" ? o.matchedOwnerId : null,
    matched_at: o.matchedAt?.toISOString() ?? null,
    todo_id: o.todoId,
    todo_synced_at: o.todoSyncedAt?.toISOString() ?? null,
    todo_closed_at: o.todoClosedAt?.toISOString() ?? null,
    todo_error: o.todoError,
  };
}

function serializeItem(i: RecurringItem, nextOccurrence?: RecurringItemOccurrence | null) {
  return {
    id: i.id,
    label: i.label,
    category: i.category,
    expected_amount: i.expectedAmount,
    cadence: i.cadence,
    interval_days: i.intervalDays,
    anchor_date: i.anchorDate,
    next_expected_date: i.nextExpectedDate,
    window_before_days: i.windowBeforeDays,
    window_after_days: i.windowAfterDays,
    merchant_hint: i.merchantHint,
    source: i.source,
    confirmed: i.confirmed,
    is_active: i.isActive,
    todo_config: i.todoConfig ?? null,
    next_occurrence: nextOccurrence ? serializeOccurrence(nextOccurrence) : null,
    created_at: i.createdAt.toISOString(),
    updated_at: i.updatedAt.toISOString(),
  };
}

async function loadOwned(userId: number, id: number): Promise<RecurringItem | undefined> {
  if (!Number.isInteger(id)) return undefined;
  const [item] = await db.select().from(recurringItems).where(and(eq(recurringItems.id, id), eq(recurringItems.userId, userId)));
  return item;
}

/** The item's next open occurrence (pending, window not yet closed), for the single-item responses. */
async function nextOpenOccurrence(itemId: number): Promise<RecurringItemOccurrence | null> {
  const [row] = await db
    .select()
    .from(recurringItemOccurrences)
    .where(and(eq(recurringItemOccurrences.recurringItemId, itemId), eq(recurringItemOccurrences.status, "pending"), gte(recurringItemOccurrences.windowEnd, todayUtc())))
    .orderBy(recurringItemOccurrences.expectedDate)
    .limit(1);
  return row ?? null;
}

async function respondWithItem(userId: number, id: number) {
  const item = (await loadOwned(userId, id))!;
  return serializeItem(item, await nextOpenOccurrence(id));
}

function logItemEvent(userId: number, item: RecurringItem, action: "created" | "updated" | "deleted") {
  return logDomainEvent(db, {
    userId,
    ownerType: "recurring_item",
    ownerId: String(item.id),
    action,
    category: item.category,
    label: item.label,
    amount: 0, // a forecast is not money spent -- see the module comment
    source: item.source,
    metadata: { expected_amount: item.expectedAmount, cadence: item.cadence, window_before_days: item.windowBeforeDays, window_after_days: item.windowAfterDays, confirmed: item.confirmed, is_active: item.isActive },
  });
}

/** Pending occurrences that haven't been handed to a to-do are just a cache of the schedule: safe to drop and rebuild. */
async function dropRebuildablePending(itemId: number) {
  await db.delete(recurringItemOccurrences).where(and(eq(recurringItemOccurrences.recurringItemId, itemId), eq(recurringItemOccurrences.status, "pending"), isNull(recurringItemOccurrences.todoId)));
}

// GET /recurring-items?active=true&confirmed=true
router.get("/", async (req, res) => {
  const userId = req.user!.userId;
  const conditions = [eq(recurringItems.userId, userId)];
  if (req.query.active === "true") conditions.push(eq(recurringItems.isActive, true));
  if (req.query.confirmed === "true") conditions.push(eq(recurringItems.confirmed, true));
  if (req.query.confirmed === "false") conditions.push(eq(recurringItems.confirmed, false));
  const items = await db.select().from(recurringItems).where(and(...conditions)).orderBy(recurringItems.nextExpectedDate, recurringItems.id);

  // Each item's next open occurrence, in one query rather than one per item.
  const ids = items.map((i) => i.id);
  const open = ids.length
    ? await db
        .select()
        .from(recurringItemOccurrences)
        .where(and(inArray(recurringItemOccurrences.recurringItemId, ids), eq(recurringItemOccurrences.status, "pending"), gte(recurringItemOccurrences.windowEnd, todayUtc())))
        .orderBy(recurringItemOccurrences.expectedDate)
    : [];
  const nextByItem = new Map<number, RecurringItemOccurrence>();
  for (const o of open) if (!nextByItem.has(o.recurringItemId)) nextByItem.set(o.recurringItemId, o);

  res.json(items.map((i) => serializeItem(i, nextByItem.get(i.id))));
});

// POST /recurring-items/todo-preview -- renders the to-do a config would produce, so
// the UI's live preview uses the server's own template engine instead of a copy.
router.post("/todo-preview", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const expectedDate = body.expected_date ?? todayUtc();
  if (!isDateString(expectedDate)) return void res.status(400).json({ error: "expected_date must be a real YYYY-MM-DD date" });
  const fields = parseItemFields({ label: body.label ?? "Example", expected_amount: body.expected_amount ?? null, window_before_days: body.window_before_days ?? 0, window_after_days: body.window_after_days ?? 0, category: body.category ?? null }, null);
  if (typeof fields === "string") return void res.status(400).json({ error: fields });
  const config = parseTodoConfig(body.todo_config ?? {}, fields.expectedAmount ?? null);
  if (typeof config === "string") return void res.status(400).json({ error: config });
  if (config === null) return void res.json({ todo: null });
  const window = windowFor(expectedDate, fields.windowBeforeDays ?? 0, fields.windowAfterDays ?? 0);
  res.json({ todo: renderTodo(config, { label: fields.label ?? "Example", expectedAmount: fields.expectedAmount ?? null, category: fields.category ?? null, expectedDate, window }), create_on: addDays(window.start, -config.lead_days) });
});

// POST /recurring-items
router.post("/", async (req, res) => {
  const userId = req.user!.userId;
  const body = (req.body ?? {}) as Record<string, unknown>;

  for (const required of ["label", "cadence", "anchor_date"]) {
    if (body[required] === undefined) return void res.status(400).json({ error: `${required} is required` });
  }
  const parsed = parseItemFields(body, null);
  if (typeof parsed === "string") return void res.status(400).json({ error: parsed });
  const fields: Partial<ItemFields> = { intervalDays: null, expectedAmount: null, ...parsed };
  const consistency = checkItemConsistency({ cadence: fields.cadence!, intervalDays: fields.intervalDays ?? null });
  if (consistency) return void res.status(400).json({ error: consistency });

  const spec = { cadence: fields.cadence!, anchorDate: fields.anchorDate!, intervalDays: fields.intervalDays ?? null, windowAfterDays: fields.windowAfterDays ?? 0 };
  const [row] = await db
    .insert(recurringItems)
    .values({
      userId,
      label: fields.label!,
      category: fields.category ?? null,
      expectedAmount: fields.expectedAmount ?? null,
      cadence: fields.cadence!,
      intervalDays: fields.intervalDays ?? null,
      anchorDate: fields.anchorDate!,
      nextExpectedDate: nextExpectedDate(spec, todayUtc()),
      windowBeforeDays: fields.windowBeforeDays ?? 0,
      windowAfterDays: fields.windowAfterDays ?? 0,
      merchantHint: fields.merchantHint ?? null,
      confirmed: fields.confirmed ?? true,
      isActive: fields.isActive ?? true,
      todoConfig: fields.todoConfig ?? null,
    })
    .returning();

  await logItemEvent(userId, row, "created");
  await materializeOccurrences(userId, todayUtc()); // so the schedule shows up now, not at the next scheduled sync
  res.status(201).json(await respondWithItem(userId, row.id));
});

// PATCH /recurring-items/:id -- edit anything, confirm a Plaid suggestion (confirmed: true), or pause/dismiss (is_active: false)
router.patch("/:id", async (req, res) => {
  const userId = req.user!.userId;
  const existing = await loadOwned(userId, Number(req.params.id));
  if (!existing) return void res.status(404).json({ error: "Recurring item not found" });

  const parsed = parseItemFields((req.body ?? {}) as Record<string, unknown>, existing.expectedAmount);
  if (typeof parsed === "string") return void res.status(400).json({ error: parsed });

  const merged = { ...existing, ...parsed };
  const consistency = checkItemConsistency({ cadence: merged.cadence as ItemFields["cadence"], intervalDays: merged.intervalDays ?? null });
  if (consistency) return void res.status(400).json({ error: consistency });

  const scheduleChanged =
    parsed.cadence !== undefined || parsed.anchorDate !== undefined || parsed.intervalDays !== undefined || parsed.windowBeforeDays !== undefined || parsed.windowAfterDays !== undefined;

  const [row] = await db
    .update(recurringItems)
    .set({
      ...parsed,
      nextExpectedDate: nextExpectedDate({ cadence: merged.cadence as ItemFields["cadence"], anchorDate: merged.anchorDate, intervalDays: merged.intervalDays, windowAfterDays: merged.windowAfterDays }, todayUtc()),
      updatedAt: new Date(),
    })
    .where(and(eq(recurringItems.id, existing.id), eq(recurringItems.userId, userId)))
    .returning();

  // A paused/dismissed item, or a changed schedule, invalidates the not-yet-sent occurrences; drop them
  // (any already handed to a to-do stay -- a person may be looking at that to-do) and rebuild if it's live.
  if (parsed.isActive === false || scheduleChanged) await dropRebuildablePending(row.id);
  await logItemEvent(userId, row, "updated");
  await materializeOccurrences(userId, todayUtc());
  res.json(await respondWithItem(userId, row.id));
});

// DELETE /recurring-items/:id -- history goes with it; to-dos already created in todo-tracker are left alone
router.delete("/:id", async (req, res) => {
  const userId = req.user!.userId;
  const existing = await loadOwned(userId, Number(req.params.id));
  if (!existing) return void res.status(404).json({ error: "Recurring item not found" });
  await db.delete(recurringItems).where(and(eq(recurringItems.id, existing.id), eq(recurringItems.userId, userId)));
  await logItemEvent(userId, existing, "deleted");
  res.status(204).send();
});

// GET /recurring-items/:id/occurrences?limit=24 -- upcoming and recent, newest first
router.get("/:id/occurrences", async (req, res) => {
  const userId = req.user!.userId;
  const existing = await loadOwned(userId, Number(req.params.id));
  if (!existing) return void res.status(404).json({ error: "Recurring item not found" });
  const limit = Math.min(Math.max(Number(req.query.limit) || 24, 1), 120);
  const rows = await db.select().from(recurringItemOccurrences).where(eq(recurringItemOccurrences.recurringItemId, existing.id)).orderBy(desc(recurringItemOccurrences.expectedDate)).limit(limit);
  res.json(rows.map(serializeOccurrence));
});

// POST /recurring-items/:id/occurrences/:occurrenceId/skip -- "not this time"; a pending occurrence only
router.post("/:id/occurrences/:occurrenceId/skip", async (req, res) => {
  const userId = req.user!.userId;
  const existing = await loadOwned(userId, Number(req.params.id));
  if (!existing) return void res.status(404).json({ error: "Recurring item not found" });
  const [row] = await db
    .update(recurringItemOccurrences)
    .set({ status: "skipped" })
    .where(and(eq(recurringItemOccurrences.id, Number(req.params.occurrenceId)), eq(recurringItemOccurrences.recurringItemId, existing.id), eq(recurringItemOccurrences.status, "pending")))
    .returning();
  if (!row) return void res.status(404).json({ error: "No pending occurrence with that id" });
  res.json(serializeOccurrence(row));
});

export default router;

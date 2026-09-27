import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { db, recurringItems, recurringItemOccurrences, domainEvents, institutions } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";

// Live-database test for recurring items (routes/recurring-items.ts,
// services/recurring-sync.ts): CRUD + validation, the range ("days to do it"),
// matching against real transactions, missed detection, the to-do hand-off to a
// (fake, in-process) todo-tracker over real HTTP, and Plaid suggestions via a stub
// adapter. Covers what a mock db can't -- the unique constraints that make the
// action safe to run repeatedly are real here.
//
// Run via: DATABASE_URL=<live-branch-url> npx vitest run --config tests/vitest.live.config.ts

const { default: app } = await import("../../artifacts/api-server/src/app.js");
const { syncPlaidSuggestions } = await import("../../artifacts/api-server/src/services/recurring-sync.js");
const { _resetCalendarPusherForTests } = await import("../../artifacts/api-server/src/lib/calendar-push.js");

const JWT_SECRET = "test-secret-for-jwt-signing";
const RUN = Date.now();
const USER_ID = 950_000_000 + (RUN % 40_000_000);
const OTHER_USER_ID = USER_ID + 1;

function tokenFor(accountId: number) {
  return jwt.sign({ accountId, email: `recurring-live-${accountId}@test.trackstack.invalid` }, JWT_SECRET, { expiresIn: "1h" });
}
const TOKEN = tokenFor(USER_ID);
const headers = { Authorization: `Bearer ${TOKEN}` };
const otherHeaders = { Authorization: `Bearer ${tokenFor(OTHER_USER_ID)}` };

const today = new Date().toISOString().slice(0, 10);
function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── A fake todo-tracker, recording every request over real HTTP ──────────────
interface Recorded { method: string; url: string; auth: string | undefined; body: any }
const received: Recorded[] = [];
let failTitles: string[] = [];
let nextTodoId = 9000;
const todoIdsBySource = new Map<string, number>();
let todoServer: http.Server;
let todoBaseUrl = "";

// A fake trackstack-gateway, recording every POST /api/calendar/entries this run makes --
// exercises the SAME reusable calendar-push.ts wrapper every future push site (this one, and
// eventually goal crossings) shares, over real HTTP, without depending on a real gateway/calendar DB.
interface RecordedCalendarPush { auth: string | undefined; body: any }
const calendarPushes: RecordedCalendarPush[] = [];
let calendarServer: http.Server;

beforeAll(async () => {
  todoServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      received.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      res.setHeader("Content-Type", "application/json");
      if (req.method === "PUT" && req.url!.startsWith("/todos/by-source/")) {
        if (failTitles.includes(body.title)) { res.statusCode = 500; return void res.end(JSON.stringify({ error: "boom" })); }
        const created = !todoIdsBySource.has(req.url!);
        if (created) todoIdsBySource.set(req.url!, nextTodoId++);
        res.statusCode = created ? 201 : 200;
        return void res.end(JSON.stringify({ id: todoIdsBySource.get(req.url!), ...body }));
      }
      if (req.method === "PATCH" && req.url!.startsWith("/todos/")) return void res.end(JSON.stringify({ id: Number(req.url!.split("/")[2]), status: body.status }));
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => todoServer.listen(0, "127.0.0.1", resolve));
  todoBaseUrl = `http://127.0.0.1:${(todoServer.address() as AddressInfo).port}`;
  process.env.TODO_API_URL = todoBaseUrl;

  calendarServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calendarPushes.push({ auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 201;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => calendarServer.listen(0, "127.0.0.1", resolve));
  process.env.CALENDAR_API_URL = `http://127.0.0.1:${(calendarServer.address() as AddressInfo).port}`;
  _resetCalendarPusherForTests(); // calendar-push.ts memoizes on first call -- force it to pick up the URL above
});

afterAll(async () => {
  todoServer?.close();
  calendarServer?.close();
  delete process.env.TODO_API_URL;
  delete process.env.CALENDAR_API_URL;
  _resetCalendarPusherForTests();
  for (const uid of [USER_ID, OTHER_USER_ID]) {
    await db.delete(institutions).where(eq(institutions.userId, uid)).catch(() => {});
    await db.delete(recurringItems).where(eq(recurringItems.userId, uid)).catch(() => {}); // occurrences cascade
    await db.delete(domainEvents).where(eq(domainEvents.userId, uid)).catch(() => {});
  }
}, 30_000);

async function createItem(body: Record<string, unknown>, h = headers) {
  return request(app).post("/api/recurring-items").set(h).send(body);
}
async function runSync(h = headers) {
  return request(app).post("/api/actions/sync-recurring/run").set(h).send({});
}
async function occurrencesOf(id: number, h = headers) {
  return (await request(app).get(`/api/recurring-items/${id}/occurrences`).set(h)).body as any[];
}
async function logTransaction(merchantName: string, amount: number, date = today) {
  const res = await request(app).post("/api/events/log").set(headers).send({ event_type: "transaction", occurred_at: date, amount, metadata: { merchantName } });
  expect(res.status).toBe(200);
  return res.body.id as string;
}
function todoCalls(method: string) {
  return received.filter((r) => r.method === method);
}

function calendarPushFor(itemId: number) {
  return calendarPushes.filter((p) => p.body?.owner_type === "recurring_item" && p.body?.owner_id === String(itemId));
}

describe("POST /recurring-items -- create and validate", () => {
  it("creates an item with a range, computes the next date, and materializes its schedule immediately", async () => {
    const res = await createItem({ label: `Rent ${RUN}`, cadence: "monthly", anchor_date: today, expected_amount: 1800, window_before_days: 1, window_after_days: 4 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ label: `Rent ${RUN}`, cadence: "monthly", expected_amount: 1800, window_before_days: 1, window_after_days: 4, confirmed: true, is_active: true, todo_config: null, source: "user" });
    expect(res.body.next_expected_date).toBe(today);
    expect(res.body.next_occurrence).toMatchObject({ expected_date: today, window_start: addDays(today, -1), window_end: addDays(today, 4), status: "pending" });

    // Saving pushes its forecast to the calendar right away, the same "on save" convention as the to-do hand-off.
    const push = calendarPushFor(res.body.id)[0];
    expect(push.body).toMatchObject({
      tracker: "finance", owner_type: "recurring_item", owner_id: String(res.body.id), action: "updated", kind: "forecast",
      label: `Rent ${RUN}`, amount: 1800, occurred_at: `${addDays(today, -1)}T00:00:00.000Z`,
    });
    expect(push.body.metadata).toMatchObject({ window_start: addDays(today, -1), window_end: addDays(today, 4) });
    expect(push.auth).toBe(headers.Authorization);
  });

  it("rejects bad input with a clear 400", async () => {
    const ok = { label: "X", cadence: "monthly", anchor_date: today };
    expect((await createItem({ cadence: "monthly", anchor_date: today })).body.error).toContain("label is required");
    expect((await createItem({ ...ok, cadence: "daily" })).status).toBe(400);
    expect((await createItem({ ...ok, cadence: "custom" })).body.error).toContain("interval_days");
    expect((await createItem({ ...ok, anchor_date: "2026-02-30" })).status).toBe(400);
    expect((await createItem({ ...ok, window_before_days: 99 })).status).toBe(400);
    expect((await createItem({ ...ok, window_after_days: -1 })).status).toBe(400);
    expect((await createItem({ ...ok, todo_config: { title_template: "{nope}" } })).body.error).toContain("{nope}");
    expect((await createItem({ ...ok, todo_config: { colour: "red" } })).status).toBe(400);
  });

  it("logs the item's creation as an event with amount 0 (a forecast must not count as spend)", async () => {
    const res = await createItem({ label: `Event ${RUN}`, cadence: "weekly", anchor_date: today, expected_amount: 999 });
    const [event] = await db.select().from(domainEvents).where(and(eq(domainEvents.ownerType, "recurring_item"), eq(domainEvents.ownerId, String(res.body.id)), eq(domainEvents.eventType, "recurring_item_created")));
    expect(event.amount).toBe(0);
    expect(JSON.parse(event.metadataJson).expected_amount).toBe(999);
  });
});

describe("scoping", () => {
  it("never shows, edits or deletes another user's item", async () => {
    const mine = (await createItem({ label: `Private ${RUN}`, cadence: "monthly", anchor_date: today })).body;
    expect((await request(app).get("/api/recurring-items").set(otherHeaders)).body.some((i: any) => i.id === mine.id)).toBe(false);
    expect((await request(app).patch(`/api/recurring-items/${mine.id}`).set(otherHeaders).send({ label: "hijack" })).status).toBe(404);
    expect((await request(app).delete(`/api/recurring-items/${mine.id}`).set(otherHeaders)).status).toBe(404);
    expect((await request(app).get(`/api/recurring-items/${mine.id}/occurrences`).set(otherHeaders)).status).toBe(404);
  });
});

describe("matching against real transactions, using the range", () => {
  it("matches a transaction posted anywhere inside the window, and records which one", async () => {
    const item = (await createItem({ label: "Zeta Utilities", cadence: "monthly", anchor_date: addDays(today, -2), expected_amount: 100, window_before_days: 0, window_after_days: 5 })).body;
    const txnId = await logTransaction("ZETA UTILITIES", 100, today); // day 2 of a 6-day window, not on the nominal date
    const res = await runSync();
    expect(res.status).toBe(200);
    expect(res.body.steps.matched).toBeGreaterThanOrEqual(1);
    const occ = (await occurrencesOf(item.id)).find((o) => o.expected_date === addDays(today, -2));
    expect(occ).toMatchObject({ status: "matched", matched_transaction_id: txnId });
  });

  it("doesn't let one transaction satisfy two occurrences", async () => {
    const item = (await createItem({ label: "Weekly Gym", cadence: "weekly", anchor_date: addDays(today, -1), expected_amount: 20, window_before_days: 1, window_after_days: 8 })).body;
    await logTransaction("WEEKLY GYM", 20, today); // sits inside BOTH the -1 and the +6 occurrence's windows
    await runSync();
    const matched = (await occurrencesOf(item.id)).filter((o) => o.status === "matched");
    expect(matched).toHaveLength(1);
  });

  it("a wrong merchant or the wrong direction is not a match", async () => {
    const item = (await createItem({ label: "Yankee Insurance", cadence: "monthly", anchor_date: today, expected_amount: 150, window_after_days: 3 })).body;
    await logTransaction("SOMETHING ELSE ENTIRELY", 150, today);
    await logTransaction("YANKEE INSURANCE", -150, today); // a refund, not the bill
    await runSync();
    expect((await occurrencesOf(item.id)).every((o) => o.status === "pending")).toBe(true);
  });

  it("marks an occurrence missed once its window (plus a day's posting slack) has closed with nothing found", async () => {
    const item = (await createItem({ label: "Quiet Subscription", cadence: "weekly", anchor_date: addDays(today, -20), expected_amount: 5, window_after_days: 2 })).body;
    await runSync();
    const occs = await occurrencesOf(item.id);
    expect(occs.some((o) => o.status === "missed")).toBe(true);
    expect(occs.find((o) => o.window_end >= today)?.status).toBe("pending"); // an open window is never missed
  });

  it("skips an occurrence on request, and only a pending one", async () => {
    const item = (await createItem({ label: "Skippable", cadence: "monthly", anchor_date: today })).body;
    const occ = (await occurrencesOf(item.id))[0];
    expect((await request(app).post(`/api/recurring-items/${item.id}/occurrences/${occ.id}/skip`).set(headers)).body.status).toBe("skipped");
    expect((await request(app).post(`/api/recurring-items/${item.id}/occurrences/${occ.id}/skip`).set(headers)).status).toBe(404);
  });
});

describe("running the action repeatedly", () => {
  it("is idempotent: a second run creates nothing new", async () => {
    await createItem({ label: `Idem ${RUN}`, cadence: "weekly", anchor_date: today });
    await runSync();
    const second = await runSync();
    expect(second.body.steps.occurrences.created).toBe(0);
    expect(second.body.steps.todos.created).toBe(0);
  });

  it("the unique constraint makes overlapping runs safe (concurrent runs create each occurrence once)", async () => {
    const item = (await createItem({ label: `Concurrent ${RUN}`, cadence: "monthly", anchor_date: addDays(today, 3) })).body;
    await db.delete(recurringItemOccurrences).where(eq(recurringItemOccurrences.recurringItemId, item.id));
    await Promise.all([runSync(), runSync(), runSync()]);
    const rows = await db.select().from(recurringItemOccurrences).where(eq(recurringItemOccurrences.recurringItemId, item.id));
    expect(new Set(rows.map((r) => r.expectedDate)).size).toBe(rows.length);
  });
});

describe("the to-do hand-off", () => {
  it("sends the configured to-do the moment an item with an open range is saved, forwarding the caller's own credential", async () => {
    received.length = 0;
    const created = await createItem({
      label: `Pay Water ${RUN}`, cadence: "monthly", anchor_date: today, expected_amount: 60, window_before_days: 0, window_after_days: 4, category: "Utilities",
      todo_config: { title_template: "Pay {label} bill", notes_template: "{amount} due {window} ({category})", category: "finance", priority: 2 },
    });
    const item = created.body;
    expect(created.body.todo_sync).toMatchObject({ created: 1, failed: 0 });
    // No sync was run: saving an item whose range is already open sends its to-do right away.
    const put = todoCalls("PUT").find((r) => r.url.includes(`recurring-${item.id}-${today}`))!;
    expect(put.url).toBe(`/todos/by-source/finance/recurring-${item.id}-${today}`);
    expect(put.auth).toBe(`Bearer ${TOKEN}`);
    // template "Pay {label} bill" wrapped around the label "Pay Water ..."
    expect(put.body).toMatchObject({ title: `Pay Pay Water ${RUN} bill`, category: "finance", priority: 2, due_at: `${addDays(today, 4)}T23:59:59.000Z` });
    expect(put.body.notes).toMatch(/^\$60\.00 due .+ \(Utilities\)$/);

    const occ = (await occurrencesOf(item.id)).find((o) => o.expected_date === today)!;
    expect(occ.todo_id).toBeGreaterThanOrEqual(9000);
    expect(occ.todo_synced_at).not.toBeNull();
  });

  it("sends each occurrence's to-do exactly once, so a person's edits in todo-tracker aren't overwritten", async () => {
    const item = (await createItem({ label: `Once ${RUN}`, cadence: "monthly", anchor_date: today, window_after_days: 3, todo_config: {} })).body;
    received.length = 0;
    await runSync();
    await runSync();
    await request(app).patch(`/api/recurring-items/${item.id}`).set(headers).send({ expected_amount: 12 }); // a re-save is not a re-send either
    expect(todoCalls("PUT").filter((r) => r.url.includes(`recurring-${item.id}-`))).toHaveLength(0);
  });

  it("closes the to-do (once) when a transaction matches the occurrence", async () => {
    const item = (await createItem({ label: "Omega Electric", cadence: "monthly", anchor_date: today, expected_amount: 90, window_after_days: 3, todo_config: {} })).body;
    const sent = (await occurrencesOf(item.id)).find((o) => o.expected_date === today)!;
    expect(sent.todo_id).not.toBeNull();

    await logTransaction("OMEGA ELECTRIC", 90, today);
    received.length = 0;
    const res = await runSync();
    expect(res.body.steps.todos.completed).toBeGreaterThanOrEqual(1);
    const patch = todoCalls("PATCH").find((r) => r.url === `/todos/${sent.todo_id}`)!;
    expect(patch.body).toEqual({ status: "done" });
    expect(patch.auth).toBe(`Bearer ${TOKEN}`);
    expect((await occurrencesOf(item.id)).find((o) => o.expected_date === today)!.todo_closed_at).not.toBeNull();

    received.length = 0;
    await runSync();
    expect(todoCalls("PATCH")).toHaveLength(0); // not closed twice
  });

  it("an occurrence already matched before its to-do existed never gets one", async () => {
    received.length = 0;
    await logTransaction("SIGMA CABLE", 70, today); // already posted when the item is created
    const created = await createItem({ label: "Sigma Cable", cadence: "monthly", anchor_date: today, expected_amount: 70, window_after_days: 3, todo_config: {} });
    await runSync(); // match runs before the to-do step, on save and in the action
    expect(todoCalls("PUT").some((r) => r.url.includes(`recurring-${created.body.id}-`))).toBe(false);
    expect(created.body.todo_sync).toMatchObject({ created: 0 });
  });

  it("puts the to-do on the list lead_days before the window opens, not before", async () => {
    received.length = 0;
    const later = (await createItem({ label: `Lead Early ${RUN}`, cadence: "annually", anchor_date: addDays(today, 10), todo_config: { lead_days: 12 } })).body;
    const tooSoon = (await createItem({ label: `Lead Late ${RUN}`, cadence: "annually", anchor_date: addDays(today, 10), todo_config: { lead_days: 3 } })).body;
    await runSync();
    const sources = todoCalls("PUT").map((r) => r.url);
    expect(sources.some((u) => u.includes(`recurring-${later.id}-`))).toBe(true); // window opens in 10 days, lead 12 -> already due
    expect(sources.some((u) => u.includes(`recurring-${tooSoon.id}-`))).toBe(false); // lead 3 -> not for 7 more days
  });

  it("records a failed hand-off, reports it, and retries successfully on the next run", async () => {
    failTitles = [`FLAKY-Flaky ${RUN}`];
    const saved = await createItem({ label: `Flaky ${RUN}`, cadence: "monthly", anchor_date: today, todo_config: { title_template: "FLAKY-{label}" } });
    expect(saved.status).toBe(201); // a failed hand-off never fails the save
    expect(saved.body.todo_sync).toMatchObject({ created: 0, failed: 1 });
    const item = saved.body;
    const failed = await runSync();
    expect(failed.body.status).toBe("partial");
    expect(failed.body.steps.todos.failed).toBeGreaterThanOrEqual(1);
    const bad = (await occurrencesOf(item.id)).find((o) => o.expected_date === today)!;
    expect(bad.todo_id).toBeNull();
    expect(bad.todo_error).toContain("500");

    failTitles = [];
    const retried = await runSync();
    expect(retried.body.steps.todos.created).toBeGreaterThanOrEqual(1);
    const good = (await occurrencesOf(item.id)).find((o) => o.expected_date === today)!;
    expect(good.todo_id).not.toBeNull();
    expect(good.todo_error).toBeNull();
  });

  it("reports the to-do step skipped -- and still does everything else -- when TODO_API_URL isn't set", async () => {
    const saved = process.env.TODO_API_URL;
    delete process.env.TODO_API_URL;
    try {
      const saved = await createItem({ label: `No Todo Server ${RUN}`, cadence: "monthly", anchor_date: today, todo_config: {} });
      expect(saved.body.todo_sync.skippedReason).toContain("TODO_API_URL");
      const item = saved.body;
      const res = await runSync();
      expect(res.body.steps.todos.skippedReason).toContain("TODO_API_URL");
      expect(res.body.steps.errors).toEqual([]);
      expect((await occurrencesOf(item.id)).length).toBeGreaterThan(0); // occurrences were still created
    } finally {
      process.env.TODO_API_URL = saved;
    }
  });

  it("previews the rendered to-do from the server's own template engine", async () => {
    const res = await request(app).post("/api/recurring-items/todo-preview").set(headers).send({
      label: "Rent", expected_amount: 1800, expected_date: "2026-10-01", window_before_days: 0, window_after_days: 4,
      todo_config: { title_template: "Pay {label}", lead_days: 2 },
    });
    expect(res.status).toBe(200);
    expect(res.body.todo).toMatchObject({ title: "Pay Rent", notes: "About $1,800.00 · anytime Oct 1–5", due_at: "2026-10-05T23:59:59.000Z" });
    expect(res.body.create_on).toBe("2026-09-29");
    expect((await request(app).post("/api/recurring-items/todo-preview").set(headers).send({ todo_config: { title_template: "{bogus}" } })).status).toBe(400);
  });
});

describe("editing", () => {
  it("changing the range or cadence rebuilds not-yet-sent occurrences; sent ones stay", async () => {
    const item = (await createItem({ label: `Edit ${RUN}`, cadence: "monthly", anchor_date: today, window_after_days: 1 })).body;
    expect((await occurrencesOf(item.id)).find((o) => o.expected_date === today)!.window_end).toBe(addDays(today, 1));
    const edited = await request(app).patch(`/api/recurring-items/${item.id}`).set(headers).send({ window_after_days: 6 });
    expect(edited.status).toBe(200);
    expect(edited.body.window_after_days).toBe(6);
    expect((await occurrencesOf(item.id)).find((o) => o.expected_date === today)!.window_end).toBe(addDays(today, 6));
  });

  it("pausing removes the item from the calendar; resuming pushes it back", async () => {
    const item = (await createItem({ label: `Calendar Pause ${RUN}`, cadence: "monthly", anchor_date: today })).body;
    calendarPushes.length = 0;
    await request(app).patch(`/api/recurring-items/${item.id}`).set(headers).send({ is_active: false });
    const [removed] = calendarPushFor(item.id);
    expect(removed.body).toMatchObject({ owner_type: "recurring_item", owner_id: String(item.id), action: "deleted" });

    calendarPushes.length = 0;
    await request(app).patch(`/api/recurring-items/${item.id}`).set(headers).send({ is_active: true });
    const [restored] = calendarPushFor(item.id);
    expect(restored.body).toMatchObject({ action: "updated", kind: "forecast" });
  });

  it("pausing drops unsent occurrences (keeping ones already handed to a to-do) and stops syncing the item; resuming brings the schedule back", async () => {
    received.length = 0;
    const item = (await createItem({ label: `Pausable ${RUN}`, cadence: "monthly", anchor_date: today, todo_config: {} })).body;
    received.length = 0; // its first to-do went out on save; what matters is nothing more goes out while paused
    await request(app).patch(`/api/recurring-items/${item.id}`).set(headers).send({ is_active: false });
    // Unsent occurrences are dropped; the one already handed to a to-do (sent on save) stays.
    const kept = await occurrencesOf(item.id);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((o) => o.todo_id !== null)).toBe(true);
    await runSync();
    expect(todoCalls("PUT").some((r) => r.url.includes(`recurring-${item.id}-`))).toBe(false);
    await request(app).patch(`/api/recurring-items/${item.id}`).set(headers).send({ is_active: true });
    expect((await occurrencesOf(item.id)).length).toBeGreaterThan(0);
  });

  it("deleting removes the item, its history, logs the deletion, and removes it from the calendar", async () => {
    const item = (await createItem({ label: `Delete ${RUN}`, cadence: "monthly", anchor_date: today })).body;
    calendarPushes.length = 0;
    expect((await request(app).delete(`/api/recurring-items/${item.id}`).set(headers)).status).toBe(204);
    const [removed] = calendarPushFor(item.id);
    expect(removed.body).toMatchObject({ owner_type: "recurring_item", owner_id: String(item.id), action: "deleted" });
    expect((await request(app).get("/api/recurring-items").set(headers)).body.some((i: any) => i.id === item.id)).toBe(false);
    expect(await db.select().from(recurringItemOccurrences).where(eq(recurringItemOccurrences.recurringItemId, item.id))).toHaveLength(0);
    const events = await db.select().from(domainEvents).where(and(eq(domainEvents.ownerType, "recurring_item"), eq(domainEvents.ownerId, String(item.id))));
    expect(events.map((e) => e.eventType).sort()).toEqual(["recurring_item_created", "recurring_item_deleted"]);
  });
});

describe("Plaid-detected suggestions", () => {
  const stream = (over: Record<string, unknown> = {}) => ({
    streamId: `stream-${RUN}-a`, accountId: "acct", description: "HULU 877-8244858", merchantName: "Hulu", frequency: "MONTHLY", status: "MATURE",
    isActive: true, direction: "outflow" as const, averageAmount: 17.99, lastAmount: 17.99, lastDate: addDays(today, -20), predictedNextDate: addDays(today, 10), ...over,
  });
  let streams: any[] = [];
  const adapter = { name: "stub", getRecurringStreams: async () => streams } as any;

  beforeAll(async () => {
    await request(app).get("/api/recurring-items").set(headers); // lazily creates the user row
    await db.insert(institutions).values({ id: `inst-${RUN}`, userId: USER_ID, name: "Stub Bank", plaidAccessToken: "stub-token" });
  });

  // active=true: a dismissed suggestion stays in the table (so it isn't suggested again) but is not listed.
  const suggestions = async () => (await request(app).get("/api/recurring-items?active=true&confirmed=false").set(headers)).body.filter((i: any) => i.source === "plaid");

  it("files a new stream as an unconfirmed suggestion, once, and never pushes it to the calendar", async () => {
    calendarPushes.length = 0;
    streams = [stream()];
    expect(await syncPlaidSuggestions(USER_ID, today, adapter)).toMatchObject({ suggested: 1, updated: 0 });
    expect(await syncPlaidSuggestions(USER_ID, today, adapter)).toMatchObject({ suggested: 0, updated: 0 });
    const [s] = await suggestions();
    expect(s).toMatchObject({ label: "Hulu", cadence: "monthly", expected_amount: 17.99, confirmed: false, source: "plaid", window_after_days: 2 });
    // ...and an unconfirmed suggestion gets no occurrences (nothing is matched or handed to a to-do until accepted)
    expect(await occurrencesOf(s.id)).toEqual([]);
    expect(calendarPushFor(s.id)).toEqual([]);
  });

  it("refreshes an untouched suggestion but never overwrites one the person confirmed", async () => {
    streams = [stream({ lastAmount: 19.99 })];
    expect((await syncPlaidSuggestions(USER_ID, today, adapter)).updated).toBe(1);
    const [s] = await suggestions();
    expect(s.expected_amount).toBe(19.99);

    await request(app).patch(`/api/recurring-items/${s.id}`).set(headers).send({ confirmed: true, expected_amount: 15 });
    streams = [stream({ lastAmount: 25 })];
    expect((await syncPlaidSuggestions(USER_ID, today, adapter)).updated).toBe(0);
    expect((await request(app).get("/api/recurring-items").set(headers)).body.find((i: any) => i.id === s.id).expected_amount).toBe(15);
    expect((await occurrencesOf(s.id)).length).toBeGreaterThan(0); // confirming starts its schedule
  });

  it("does not re-suggest a dismissed stream, or one you already track by hand", async () => {
    streams = [stream({ streamId: `stream-${RUN}-b`, merchantName: "Spotify", description: "SPOTIFY USA", lastAmount: 10.99 })];
    await syncPlaidSuggestions(USER_ID, today, adapter);
    const spotify = (await suggestions()).find((i: any) => i.label === "Spotify");
    await request(app).patch(`/api/recurring-items/${spotify.id}`).set(headers).send({ is_active: false }); // dismiss
    expect((await syncPlaidSuggestions(USER_ID, today, adapter)).suggested).toBe(0);
    expect((await suggestions()).some((i: any) => i.label === "Spotify")).toBe(false);

    await createItem({ label: "Netflix", cadence: "monthly", anchor_date: today, merchant_hint: "Netflix" });
    streams = [stream({ streamId: `stream-${RUN}-c`, merchantName: "Netflix", description: "NETFLIX.COM", lastAmount: 15.49 })];
    expect((await syncPlaidSuggestions(USER_ID, today, adapter)).suggested).toBe(0);
  });

  it("skips streams that shouldn't be suggested, and survives a Plaid failure", async () => {
    streams = [stream({ streamId: `stream-${RUN}-d`, frequency: "UNKNOWN" }), stream({ streamId: `stream-${RUN}-e`, status: "TOMBSTONED" })];
    expect((await syncPlaidSuggestions(USER_ID, today, adapter)).suggested).toBe(0);
    const broken = { name: "stub", getRecurringStreams: async () => { throw new Error("ITEM_LOGIN_REQUIRED"); } } as any;
    expect(await syncPlaidSuggestions(USER_ID, today, broken)).toMatchObject({ suggested: 0, error: "ITEM_LOGIN_REQUIRED" });
  });

  it("accepting a suggestion is the moment it becomes calendar-worthy", async () => {
    streams = [stream({ streamId: `stream-${RUN}-f`, merchantName: "Disney Plus", description: "DISNEY PLUS", lastAmount: 13.99 })];
    await syncPlaidSuggestions(USER_ID, today, adapter);
    const s = (await suggestions()).find((i: any) => i.label === "Disney Plus");
    expect(calendarPushFor(s.id)).toEqual([]); // not yet -- still unconfirmed

    calendarPushes.length = 0;
    await request(app).patch(`/api/recurring-items/${s.id}`).set(headers).send({ confirmed: true });
    expect(calendarPushFor(s.id)[0]?.body).toMatchObject({ action: "updated", kind: "forecast" });
  });
});

import { describe, it, expect } from "vitest";
import { mapStreamToSuggestion } from "../../artifacts/api-server/src/lib/recurring-plaid.js";
import { parseItemFields, parseTodoConfig, checkItemConsistency } from "../../artifacts/api-server/src/lib/recurring-validation.js";
import type { PlaidRecurringStream } from "../../artifacts/api-server/src/services/plaid.js";

const stream = (over: Partial<PlaidRecurringStream> = {}): PlaidRecurringStream => ({
  streamId: "s1",
  accountId: "a1",
  description: "NETFLIX.COM",
  merchantName: "Netflix",
  frequency: "MONTHLY",
  status: "MATURE",
  isActive: true,
  direction: "outflow",
  averageAmount: 15.49,
  lastAmount: 15.99,
  lastDate: "2026-09-03",
  predictedNextDate: "2026-10-03",
  ...over,
});

describe("Plaid recurring stream -> suggested item", () => {
  it("maps a monthly outflow, using the latest amount and the predicted next date", () => {
    expect(mapStreamToSuggestion(stream())).toEqual({
      source: "plaid",
      sourceId: "s1",
      label: "Netflix",
      merchantHint: "Netflix",
      cadence: "monthly",
      anchorDate: "2026-10-03",
      expectedAmount: 15.99,
      windowBeforeDays: 0,
      windowAfterDays: 2,
    });
  });

  it("an inflow (a paycheck) becomes a negative expected amount, like bank_transactions", () => {
    expect(mapStreamToSuggestion(stream({ direction: "inflow", merchantName: null, description: "ACME PAYROLL", averageAmount: 2000, lastAmount: null }))?.expectedAmount).toBe(-2000);
  });

  it("maps every supported frequency and skips the rest", () => {
    const cadenceOf = (frequency: string) => mapStreamToSuggestion(stream({ frequency }))?.cadence;
    expect(cadenceOf("WEEKLY")).toBe("weekly");
    expect(cadenceOf("BIWEEKLY")).toBe("biweekly");
    expect(cadenceOf("SEMI_MONTHLY")).toBe("semi_monthly");
    expect(cadenceOf("ANNUALLY")).toBe("annually");
    expect(cadenceOf("UNKNOWN")).toBeUndefined();
  });

  it("skips tombstoned, inactive, dateless and nameless streams", () => {
    expect(mapStreamToSuggestion(stream({ status: "TOMBSTONED" }))).toBeNull();
    expect(mapStreamToSuggestion(stream({ isActive: false }))).toBeNull();
    expect(mapStreamToSuggestion(stream({ predictedNextDate: null, lastDate: null }))).toBeNull();
    expect(mapStreamToSuggestion(stream({ merchantName: null, description: "  " }))).toBeNull();
    expect(mapStreamToSuggestion(stream({ predictedNextDate: null }))?.anchorDate).toBe("2026-09-03"); // falls back to the last date
  });
});

describe("item field validation", () => {
  const ok = { label: "Rent", cadence: "monthly", anchor_date: "2026-09-01", expected_amount: 1800, window_before_days: 0, window_after_days: 4 };

  it("parses a valid item to camelCase fields", () => {
    expect(parseItemFields(ok, null)).toMatchObject({ label: "Rent", cadence: "monthly", anchorDate: "2026-09-01", expectedAmount: 1800, windowBeforeDays: 0, windowAfterDays: 4 });
  });

  it("rejects bad values field by field", () => {
    expect(parseItemFields({ ...ok, label: "  " }, null)).toContain("label");
    expect(parseItemFields({ ...ok, cadence: "daily" }, null)).toContain("cadence");
    expect(parseItemFields({ ...ok, anchor_date: "2026-02-30" }, null)).toContain("anchor_date");
    expect(parseItemFields({ ...ok, window_before_days: -1 }, null)).toContain("window_before_days");
    expect(parseItemFields({ ...ok, window_after_days: 61 }, null)).toContain("window_after_days");
    expect(parseItemFields({ ...ok, window_after_days: 1.5 }, null)).toContain("window_after_days");
    expect(parseItemFields({ ...ok, expected_amount: "1800" }, null)).toContain("expected_amount");
    expect(parseItemFields({ ...ok, interval_days: 0 }, null)).toContain("interval_days");
  });

  it("only parses the fields present (PATCH)", () => {
    expect(parseItemFields({ window_after_days: 2 }, null)).toEqual({ windowAfterDays: 2 });
  });

  it("a custom cadence needs an interval", () => {
    expect(checkItemConsistency({ cadence: "custom", intervalDays: null })).toContain("interval_days");
    expect(checkItemConsistency({ cadence: "custom", intervalDays: 10 })).toBeNull();
    expect(checkItemConsistency({ cadence: "monthly", intervalDays: null })).toBeNull();
  });
});

describe("todo_config validation", () => {
  it("null means no to-do sync; an empty object means 'the defaults'", () => {
    expect(parseTodoConfig(null, 100)).toBeNull();
    expect(parseTodoConfig({}, 100)).toMatchObject({ enabled: true, lead_days: 0, due: "window_end", title_template: "{label}", category: "finance", priority: 1 });
    expect((parseTodoConfig({}, null) as any).notes_template).toBe("Anytime {window}");
  });

  it("accepts every field and keeps unset ones at the defaults", () => {
    expect(parseTodoConfig({ lead_days: 3, due: "expected_date", title_template: "Pay {label}!", priority: 2 }, 100)).toMatchObject({
      lead_days: 3, due: "expected_date", title_template: "Pay {label}!", priority: 2, enabled: true,
    });
  });

  it("rejects unknown keys, bad ranges, and bad templates", () => {
    expect(parseTodoConfig({ colour: "red" }, null)).toContain("colour");
    expect(parseTodoConfig({ lead_days: 61 }, null)).toContain("lead_days");
    expect(parseTodoConfig({ due: "never" }, null)).toContain("due");
    expect(parseTodoConfig({ priority: 0 }, null)).toContain("priority");
    expect(parseTodoConfig({ title_template: "{nope}" }, null)).toContain("{nope}");
    expect(parseTodoConfig({ title_template: "  " }, null)).toContain("title_template");
    expect(parseTodoConfig({ notes_template: "{label" }, null)).toContain("unmatched");
    expect(parseTodoConfig("yes", null)).toContain("object");
    expect(parseTodoConfig([], null)).toContain("object");
  });
});

import { describe, it, expect } from "vitest";
import {
  isDateString,
  addDays,
  nthOccurrence,
  occurrencesThrough,
  windowFor,
  plannedOccurrences,
  nextExpectedDate,
  defaultTodoConfig,
  validateTemplate,
  renderTemplate,
  renderTodo,
  formatWindow,
  formatAmount,
  todoCreateDate,
  todoSourceId,
  type CadenceSpec,
} from "../../artifacts/api-server/src/lib/recurrence.js";

const monthly = (anchorDate: string): CadenceSpec => ({ cadence: "monthly", anchorDate });

describe("dates", () => {
  it("rejects impossible dates, not just malformed ones", () => {
    expect(isDateString("2026-09-30")).toBe(true);
    expect(isDateString("2026-02-30")).toBe(false);
    expect(isDateString("2026-9-3")).toBe(false);
    expect(isDateString(20260930)).toBe(false);
  });

  it("adds days across month, year and leap boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("cadence dates", () => {
  it("weekly, biweekly and custom step by fixed days from the anchor", () => {
    expect(nthOccurrence({ cadence: "weekly", anchorDate: "2026-09-01" }, 3)).toBe("2026-09-22");
    expect(nthOccurrence({ cadence: "biweekly", anchorDate: "2026-09-01" }, 2)).toBe("2026-09-29");
    expect(nthOccurrence({ cadence: "custom", anchorDate: "2026-09-01", intervalDays: 10 }, 3)).toBe("2026-10-01");
  });

  it("monthly keeps the anchor's day and clamps to short months WITHOUT drifting", () => {
    const spec = monthly("2026-01-31");
    expect(nthOccurrence(spec, 1)).toBe("2026-02-28");
    expect(nthOccurrence(spec, 2)).toBe("2026-03-31"); // back to the 31st, not stuck on the 28th
    expect(nthOccurrence(spec, 3)).toBe("2026-04-30");
    expect(nthOccurrence(monthly("2026-11-15"), 3)).toBe("2027-02-15"); // year rollover
  });

  it("annually handles Feb 29 in non-leap years", () => {
    const spec: CadenceSpec = { cadence: "annually", anchorDate: "2028-02-29" };
    expect(nthOccurrence(spec, 1)).toBe("2029-02-28");
    expect(nthOccurrence(spec, 4)).toBe("2032-02-29");
  });

  it("semi_monthly is two dates a month, 15 apart, from either anchor half", () => {
    const first: CadenceSpec = { cadence: "semi_monthly", anchorDate: "2026-09-01" };
    expect([0, 1, 2, 3].map((n) => nthOccurrence(first, n))).toEqual(["2026-09-01", "2026-09-16", "2026-10-01", "2026-10-16"]);
    const second: CadenceSpec = { cadence: "semi_monthly", anchorDate: "2026-09-20" };
    expect([0, 1, 2].map((n) => nthOccurrence(second, n))).toEqual(["2026-09-20", "2026-10-05", "2026-10-20"]);
  });

  it("lists occurrences through a date, in order, starting at the anchor", () => {
    expect(occurrencesThrough({ cadence: "weekly", anchorDate: "2026-09-01" }, "2026-09-22")).toEqual(["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22"]);
    expect(occurrencesThrough(monthly("2026-10-01"), "2026-09-30")).toEqual([]); // anchor in the future
  });
});

describe("the range (days to do it)", () => {
  it("is the nominal date minus before-days to plus after-days", () => {
    expect(windowFor("2026-09-01", 0, 4)).toEqual({ start: "2026-09-01", end: "2026-09-05" });
    expect(windowFor("2026-09-01", 3, 2)).toEqual({ start: "2026-08-29", end: "2026-09-03" });
    expect(windowFor("2026-09-01", 0, 0)).toEqual({ start: "2026-09-01", end: "2026-09-01" });
  });

  it("plans recent, current and upcoming occurrences but not old history", () => {
    // Monthly on the 1st, anchored a year back: only windows that closed within a week, or are open/upcoming.
    const planned = plannedOccurrences({ ...monthly("2025-09-01"), windowBeforeDays: 0, windowAfterDays: 4 }, { today: "2026-09-13" });
    expect(planned.map((p) => p.expectedDate)).toEqual(["2026-10-01"]); // Sep 1's window closed Sep 5, more than 7 days ago
    const recent = plannedOccurrences({ ...monthly("2025-09-01"), windowBeforeDays: 0, windowAfterDays: 4 }, { today: "2026-09-08" });
    expect(recent.map((p) => p.expectedDate)).toEqual(["2026-09-01", "2026-10-01"]); // closed Sep 5, 3 days ago: still inside the lookback
  });

  it("includes an occurrence whose window has opened even if its date is past the horizon", () => {
    const planned = plannedOccurrences({ ...monthly("2026-10-20"), windowBeforeDays: 30, windowAfterDays: 0 }, { today: "2026-09-25", horizonDays: 5 });
    expect(planned.map((p) => p.expectedDate)).toEqual(["2026-10-20"]); // window opens Sep 20
  });

  it("does not plan occurrences before the anchor", () => {
    expect(plannedOccurrences({ ...monthly("2026-12-01"), windowBeforeDays: 0, windowAfterDays: 0 }, { today: "2026-09-01", horizonDays: 45 })).toEqual([]);
  });

  it("nextExpectedDate is the first occurrence whose window hasn't closed (today counts)", () => {
    const spec = { ...monthly("2026-01-01"), windowAfterDays: 4 };
    expect(nextExpectedDate(spec, "2026-09-03")).toBe("2026-09-01"); // window open until Sep 5
    expect(nextExpectedDate(spec, "2026-09-05")).toBe("2026-09-01"); // the last day still counts
    expect(nextExpectedDate(spec, "2026-09-06")).toBe("2026-10-01");
  });
});

describe("to-do templates", () => {
  const ctx = { label: "Rent", expectedAmount: 1800, category: "Housing", expectedDate: "2026-09-01", window: { start: "2026-09-01", end: "2026-09-05" } };

  it("fills the closed placeholder set", () => {
    expect(renderTemplate("Pay {label} ({category}) {amount}", ctx)).toBe("Pay Rent (Housing) $1,800.00");
    expect(renderTemplate("{window} | {window_start} -> {window_end} | due {expected_date}", ctx)).toBe("Sep 1–5 | 2026-09-01 -> 2026-09-05 | due 2026-09-01");
  });

  it("formats windows and signed amounts readably", () => {
    expect(formatWindow({ start: "2026-09-01", end: "2026-09-01" })).toBe("Sep 1");
    expect(formatWindow({ start: "2026-09-28", end: "2026-10-02" })).toBe("Sep 28 – Oct 2");
    expect(formatAmount(-2000)).toBe("+$2,000.00"); // money in
    expect(formatAmount(1800.5)).toBe("$1,800.50");
    expect(formatAmount(null)).toBe("");
  });

  it("rejects unknown placeholders and stray braces at save time", () => {
    expect(validateTemplate("Pay {label} {window}", "t", 200)).toBeNull();
    expect(validateTemplate("Pay {who}", "t", 200)).toContain("{who}");
    expect(validateTemplate("Pay {label", "t", 200)).toContain("unmatched brace");
    expect(validateTemplate("Pay label}", "t", 200)).toContain("unmatched brace");
    expect(validateTemplate("x".repeat(201), "t", 200)).toContain("at most 200");
  });

  it("never evaluates anything -- braces that aren't placeholders are rejected, not run", () => {
    expect(validateTemplate("${process.env.X}", "t", 200)).not.toBeNull();
    expect(validateTemplate("{constructor}", "t", 200)).not.toBeNull();
  });

  it("builds the whole to-do: default config, due date choice, and a title that can't come out empty", () => {
    const config = defaultTodoConfig(1800);
    expect(renderTodo(config, ctx)).toEqual({
      title: "Rent",
      notes: "About $1,800.00 · anytime Sep 1–5",
      category: "finance",
      priority: 1,
      due_at: "2026-09-05T23:59:59.000Z",
    });
    expect(renderTodo({ ...config, due: "expected_date" }, ctx).due_at).toBe("2026-09-01T23:59:59.000Z");
    expect(renderTodo({ ...config, title_template: "{category}" }, { ...ctx, category: null }).title).toBe("Rent"); // falls back to the label
    expect(defaultTodoConfig(null).notes_template).toBe("Anytime {window}");
  });

  it("puts the to-do on the list lead_days before the window opens", () => {
    const window = { start: "2026-09-10", end: "2026-09-14" };
    expect(todoCreateDate(window, { ...defaultTodoConfig(null), lead_days: 0 })).toBe("2026-09-10");
    expect(todoCreateDate(window, { ...defaultTodoConfig(null), lead_days: 3 })).toBe("2026-09-07");
  });

  it("derives a deterministic source id so a re-run can't make a second to-do", () => {
    expect(todoSourceId(42, "2026-09-01")).toBe("recurring-42-2026-09-01");
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { addDays, weekBounds, friendlyDate, todayIso } from "../../artifacts/receipt-wallet/src/lib/day-utils";

// The Transactions page's Daily view filters the API by these strings, so the
// arithmetic must be calendar-exact (month/year rollover, leap day, DST).

afterEach(() => vi.useRealTimers());

describe("addDays", () => {
  it("rolls over month and year boundaries", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29"); // leap year
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
  });

  it("is unaffected by daylight-saving changes (23h/25h local days)", () => {
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08"); // US spring forward
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02"); // US fall back
    expect(addDays("2026-11-01", -1)).toBe("2026-10-31");
  });
});

describe("weekBounds (Sunday to Saturday)", () => {
  it("returns the week around a mid-week day", () => {
    // 2026-09-23 is a Wednesday
    expect(weekBounds("2026-09-23")).toEqual({ start: "2026-09-20", end: "2026-09-26" });
  });

  it("a Sunday starts its own week and a Saturday ends it", () => {
    expect(weekBounds("2026-09-20")).toEqual({ start: "2026-09-20", end: "2026-09-26" });
    expect(weekBounds("2026-09-26")).toEqual({ start: "2026-09-20", end: "2026-09-26" });
  });

  it("spans month and year boundaries", () => {
    expect(weekBounds("2026-10-01")).toEqual({ start: "2026-09-27", end: "2026-10-03" });
    expect(weekBounds("2027-01-01")).toEqual({ start: "2026-12-27", end: "2027-01-02" });
  });
});

describe("friendlyDate", () => {
  it("names today and yesterday, dates everything else", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 26, 12, 0, 0));
    expect(todayIso()).toBe("2026-09-26");
    expect(friendlyDate("2026-09-26")).toBe("Today");
    expect(friendlyDate("2026-09-25")).toBe("Yesterday");
    expect(friendlyDate("2026-09-21")).toBe("Mon, Sep 21");
    expect(friendlyDate("2025-12-31")).toContain("2025"); // other years keep the year
  });
});

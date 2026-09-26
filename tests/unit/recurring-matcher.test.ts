import { describe, it, expect } from "vitest";
import {
  bestMatch,
  scoreTransaction,
  scoreDateAgainstWindow,
  scoreAmountAgainstExpected,
  AUTO_MATCH_THRESHOLD,
} from "../../artifacts/api-server/src/services/recurring-matcher.js";

const window = { start: "2026-09-01", end: "2026-09-05" };
const rent = { expectedAmount: 1800, merchantHint: "Oak Street Apartments", window };
const txn = (over: Partial<{ id: string; amount: number; date: string; merchantName: string | null }> = {}) => ({
  id: "t1",
  amount: 1800,
  date: "2026-09-03",
  merchantName: "OAK STREET APARTMENTS",
  ...over,
});

describe("date against the window", () => {
  it("full credit anywhere inside the range, partial a day outside, none beyond", () => {
    expect(scoreDateAgainstWindow("2026-09-01", window)).toBe(1);
    expect(scoreDateAgainstWindow("2026-09-05", window)).toBe(1);
    expect(scoreDateAgainstWindow("2026-08-31", window)).toBe(0.7); // banks post late
    expect(scoreDateAgainstWindow("2026-09-06", window)).toBe(0.7);
    expect(scoreDateAgainstWindow("2026-09-07", window)).toBe(0);
    expect(scoreDateAgainstWindow("2026-08-30", window)).toBe(0);
  });
});

describe("amount against the expected amount", () => {
  it("is exact within a few percent, tapers off, then fails", () => {
    expect(scoreAmountAgainstExpected(1800, 1800)).toBe(1);
    expect(scoreAmountAgainstExpected(1800, 1850)).toBe(1); // within 5%
    const partial = scoreAmountAgainstExpected(1800, 1950)!;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(0.7);
    expect(scoreAmountAgainstExpected(1800, 2500)).toBe(0);
  });

  it("is absent (null), not zero, when the item has no expected amount", () => {
    expect(scoreAmountAgainstExpected(null, 42)).toBeNull();
  });

  it("never matches money in against money out", () => {
    expect(scoreAmountAgainstExpected(1800, -1800)).toBe(0);
    expect(scoreAmountAgainstExpected(-2000, -2000)).toBe(1); // paycheck vs paycheck
  });
});

describe("picking the transaction", () => {
  it("matches the right transaction inside the window", () => {
    const match = bestMatch(rent, [txn({ id: "other", merchantName: "SHELL OIL", amount: 40 }), txn()]);
    expect(match?.transaction.id).toBe("t1");
    expect(match!.composite).toBeGreaterThanOrEqual(AUTO_MATCH_THRESHOLD);
  });

  it("doesn't match outside the window, the wrong merchant, or the wrong amount", () => {
    expect(bestMatch(rent, [txn({ date: "2026-09-20" })])).toBeNull();
    expect(bestMatch(rent, [txn({ merchantName: "SHELL OIL" })])).toBeNull();
    expect(bestMatch(rent, [txn({ amount: 400 })])).toBeNull();
    expect(bestMatch(rent, [txn({ amount: -1800 })])).toBeNull();
  });

  it("an amountless item (a chore) matches on date and merchant alone", () => {
    const chore = { expectedAmount: null, merchantHint: "Comcast", window };
    expect(bestMatch(chore, [txn({ merchantName: "COMCAST CABLE", amount: 79.99 })])?.transaction.id).toBe("t1");
    expect(bestMatch(chore, [txn({ merchantName: "SPOTIFY", amount: 79.99 })])).toBeNull();
  });

  it("a wildly different merchant is never enough, whatever else lines up", () => {
    expect(scoreTransaction(rent, txn({ merchantName: "ZELLE PAYMENT 123456" }))).toBeNull();
  });

  it("prefers the stronger of two candidates, and the earlier on a tie", () => {
    const close = txn({ id: "close", amount: 1800, date: "2026-09-02" });
    const worse = txn({ id: "worse", amount: 1850, date: "2026-09-04" });
    expect(bestMatch(rent, [worse, close])?.transaction.id).toBe("close");
    const a = txn({ id: "a", date: "2026-09-02" });
    const b = txn({ id: "b", date: "2026-09-04" });
    expect(bestMatch(rent, [b, a])?.transaction.id).toBe("a");
  });
});

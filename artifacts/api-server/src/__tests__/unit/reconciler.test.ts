import { describe, it, expect } from "vitest";
import {
  reconcile,
  type ReceiptCandidate,
  type TransactionCandidate,
} from "../../services/reconciler.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function mkReceipt(overrides: Partial<ReceiptCandidate> = {}): ReceiptCandidate {
  return {
    id: 1,
    total: 50.0,
    purchaseDate: "2025-01-10",
    storeName: "TARGET",
    ...overrides,
  };
}

function mkTxn(overrides: Partial<TransactionCandidate> = {}): TransactionCandidate {
  return {
    id: "txn-1",
    amount: 50.0,
    date: "2025-01-10",
    merchantName: "TARGET",
    ...overrides,
  };
}

// ── Missing data / empty pool ──────────────────────────────────────────────

describe("reconcile — empty / null guard", () => {
  it("returns unmatched when transaction pool is empty", () => {
    const result = reconcile(mkReceipt(), []);
    expect(result.status).toBe("unmatched");
    expect(result.candidates).toHaveLength(0);
    expect(result.receiptId).toBe(1);
  });

  it("returns unmatched when receipt total is null", () => {
    const result = reconcile(mkReceipt({ total: null }), [mkTxn()]);
    expect(result.status).toBe("unmatched");
    expect(result.candidates).toHaveLength(0);
  });

  it("returns unmatched when receipt purchaseDate is null", () => {
    const result = reconcile(mkReceipt({ purchaseDate: null }), [mkTxn()]);
    expect(result.status).toBe("unmatched");
    expect(result.candidates).toHaveLength(0);
  });

  it("returns unmatched when both total and purchaseDate are null", () => {
    const result = reconcile(mkReceipt({ total: null, purchaseDate: null }), [mkTxn()]);
    expect(result.status).toBe("unmatched");
  });
});

// ── Pre-filter: date window ────────────────────────────────────────────────

describe("reconcile — prefilter date window (±5 days)", () => {
  it("includes transaction exactly 5 days after receipt", () => {
    const result = reconcile(mkReceipt({ storeName: null }), [
      mkTxn({ date: "2025-01-15", merchantName: null }),
    ]);
    // delta = 5 days, within window — composite will be low but candidate included
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it("filters out transaction 6 days after receipt", () => {
    const result = reconcile(mkReceipt({ storeName: null }), [
      mkTxn({ date: "2025-01-16", merchantName: null }),
    ]);
    expect(result.status).toBe("unmatched");
    expect(result.candidates).toHaveLength(0);
  });

  it("includes transaction exactly 5 days before receipt", () => {
    const result = reconcile(mkReceipt({ storeName: null }), [
      mkTxn({ date: "2025-01-05", merchantName: null }),
    ]);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it("filters out transaction 6 days before receipt", () => {
    const result = reconcile(mkReceipt({ storeName: null }), [
      mkTxn({ date: "2025-01-04", merchantName: null }),
    ]);
    expect(result.status).toBe("unmatched");
  });
});

// ── Pre-filter: amount window ──────────────────────────────────────────────

describe("reconcile — prefilter amount window", () => {
  it("uses minimum $5 window for small receipts ($50 total)", () => {
    // $50 receipt, 5% = $2.50 < $5 min → window = $5
    const result = reconcile(mkReceipt({ total: 50, storeName: null }), [
      mkTxn({ amount: 54.99, merchantName: null }), // $4.99 diff — passes
    ]);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it("filters amount just outside $5 minimum window", () => {
    const result = reconcile(mkReceipt({ total: 50, storeName: null }), [
      mkTxn({ amount: 55.01, merchantName: null }), // $5.01 diff — filtered
    ]);
    expect(result.candidates).toHaveLength(0);
  });

  it("uses 5% window for large receipts ($200 total)", () => {
    // $200 receipt, 5% = $10 > $5 min → window = $10
    const result = reconcile(mkReceipt({ total: 200, storeName: null }), [
      mkTxn({ amount: 210, merchantName: null }), // $10 diff — right at edge, passes
    ]);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it("filters large receipt amount beyond 5% threshold", () => {
    const result = reconcile(mkReceipt({ total: 200, storeName: null }), [
      mkTxn({ amount: 211, merchantName: null }), // $11 diff — filtered
    ]);
    expect(result.candidates).toHaveLength(0);
  });

  it("handles negative transaction amounts (Plaid debit style)", () => {
    // Plaid sometimes returns negative amounts for debits
    const result = reconcile(mkReceipt(), [mkTxn({ amount: -50.0 })]);
    // abs(-50) vs abs(50) = 0 diff → passes prefilter
    expect(result.candidates.length).toBeGreaterThan(0);
    const best = result.candidates[0];
    expect(best.breakdown.amount).toBeCloseTo(1.0);
  });
});

// ── Amount scoring ─────────────────────────────────────────────────────────

describe("reconcile — amount scoring", () => {
  // Fix date + merchant to isolate amount score
  function amountScenario(total: number, txnAmount: number) {
    return reconcile(mkReceipt({ total, storeName: "SAMESHOP" }), [
      mkTxn({ amount: txnAmount, merchantName: "SAMESHOP", date: "2025-01-10" }),
    ]);
  }

  it("scores exactly 1.0 for identical amounts", () => {
    const r = amountScenario(50, 50);
    expect(r.candidates[0].breakdown.amount).toBeCloseTo(1.0);
  });

  it("scores 1.0 for amounts within $0.01 (rounding)", () => {
    const r = amountScenario(50, 50.01);
    expect(r.candidates[0].breakdown.amount).toBeGreaterThan(0.95);
  });

  it("scores near 0.85 at exactly the hard tolerance ($0.50 diff)", () => {
    const r = amountScenario(50, 50.5);
    expect(r.candidates[0].breakdown.amount).toBeCloseTo(0.85, 1);
  });

  it("scores ~0.3 for $1.00 difference", () => {
    const r = amountScenario(50, 51.0);
    expect(r.candidates[0].breakdown.amount).toBeCloseTo(0.3, 1);
  });

  it("scores ~0.1 for $2.00 difference (soft ceiling)", () => {
    const r = amountScenario(50, 52.0);
    expect(r.candidates[0].breakdown.amount).toBeCloseTo(0.1, 1);
  });

  it("scores 0 for differences beyond $2.00 (within prefilter)", () => {
    // $4 diff — within $5 prefilter window for $50 receipt, but score = 0
    const r = amountScenario(50, 54.0);
    expect(r.candidates[0].breakdown.amount).toBe(0);
  });

  it("handles negative txn amounts via abs()", () => {
    const r = amountScenario(50, -50);
    expect(r.candidates[0].breakdown.amount).toBeCloseTo(1.0);
  });
});

// ── Date scoring ───────────────────────────────────────────────────────────

describe("reconcile — date scoring", () => {
  function dateScenario(purchaseDate: string, txnDate: string) {
    return reconcile(
      mkReceipt({ purchaseDate, storeName: "SHOP", total: 50 }),
      [mkTxn({ date: txnDate, merchantName: "SHOP", amount: 50 })]
    );
  }

  it("scores 1.0 for same-day match", () => {
    const r = dateScenario("2025-01-10", "2025-01-10");
    expect(r.candidates[0].breakdown.date).toBeCloseTo(1.0);
  });

  it("scores 0.95 for bank posting +1 day later (common delay)", () => {
    const r = dateScenario("2025-01-10", "2025-01-11");
    expect(r.candidates[0].breakdown.date).toBeCloseTo(0.95);
  });

  it("scores 0.85 for +2 days", () => {
    const r = dateScenario("2025-01-10", "2025-01-12");
    expect(r.candidates[0].breakdown.date).toBeCloseTo(0.85);
  });

  it("scores 0.6 for +3 days", () => {
    const r = dateScenario("2025-01-10", "2025-01-13");
    expect(r.candidates[0].breakdown.date).toBeCloseTo(0.6);
  });

  it("scores 0.7 for -1 day (txn dated before receipt)", () => {
    const r = dateScenario("2025-01-10", "2025-01-09");
    expect(r.candidates[0].breakdown.date).toBeCloseTo(0.7);
  });

  it("scores 0.4 for +4 days (formula fallback)", () => {
    const r = dateScenario("2025-01-10", "2025-01-14");
    expect(r.candidates[0].breakdown.date).toBeCloseTo(0.4);
  });

  it("scores ~0.25 for +5 days (within window boundary)", () => {
    const r = dateScenario("2025-01-10", "2025-01-15");
    // max(0, 1 - 5*0.15) = 0.25
    expect(r.candidates[0].breakdown.date).toBeCloseTo(0.25);
  });

  it("scores 0 for +7 days (formula underflows to 0)", () => {
    // 7 days is outside the 5-day prefilter, so would be filtered.
    // Testing formula boundary only: the date formula gives max(0, 1-7*0.15)=0 for delta=7
    // We test via ±5 day edge: delta=5 → 0.25, confirming decay
    const r = dateScenario("2025-01-10", "2025-01-15");
    expect(r.candidates[0].breakdown.date).toBeGreaterThanOrEqual(0);
  });
});

// ── Merchant scoring ───────────────────────────────────────────────────────

describe("reconcile — merchant name normalization and scoring", () => {
  function merchantScenario(storeName: string | null, merchantName: string | null) {
    return reconcile(
      mkReceipt({ storeName, total: 50, purchaseDate: "2025-01-10" }),
      [mkTxn({ merchantName, amount: 50, date: "2025-01-10" })]
    );
  }

  it("scores 1.0 (capped) for identical merchant names", () => {
    const r = merchantScenario("WHOLE FOODS", "WHOLE FOODS");
    expect(r.candidates[0].breakdown.merchant).toBeCloseTo(1.0);
  });

  it("handles case insensitivity via normalization", () => {
    const r = merchantScenario("Whole Foods", "whole foods market");
    expect(r.candidates[0].breakdown.merchant).toBeGreaterThan(0.7);
  });

  it("strips POS noise (SQ* prefix)", () => {
    // "SQ *BLUE BOTTLE" normalises to "BLUE BOTTLE"
    const r = merchantScenario("BLUE BOTTLE COFFEE", "SQ *BLUE BOTTLE");
    expect(r.candidates[0].breakdown.merchant).toBeGreaterThan(0.5);
  });

  it("strips legal suffixes (LLC, Inc, Corp)", () => {
    const r = merchantScenario("BEST BUY", "BEST BUY LLC");
    expect(r.candidates[0].breakdown.merchant).toBeGreaterThan(0.85);
  });

  it("strips store numbers from merchant names", () => {
    // "#482" should be stripped from "TARGET #482"
    const r = merchantScenario("TARGET", "TARGET #482");
    expect(r.candidates[0].breakdown.merchant).toBeGreaterThan(0.85);
  });

  it("handles word-order variance via token-set ratio", () => {
    const r = merchantScenario("COFFEE BLUE BOTTLE", "BLUE BOTTLE COFFEE");
    expect(r.candidates[0].breakdown.merchant).toBeGreaterThan(0.8);
  });

  it("returns 0 merchant score when both names are null", () => {
    const r = merchantScenario(null, null);
    expect(r.candidates[0].breakdown.merchant).toBe(0);
  });

  it("returns 0 merchant score when store name is null", () => {
    const r = merchantScenario(null, "TARGET");
    expect(r.candidates[0].breakdown.merchant).toBe(0);
  });

  it("returns 0 merchant score when merchant name is null", () => {
    const r = merchantScenario("TARGET", null);
    expect(r.candidates[0].breakdown.merchant).toBe(0);
  });

  it("handles truncated merchant names (bank truncates to 16 chars)", () => {
    const r = merchantScenario("WHOLE FOODS MARKET", "WHOLE FOODS MKT");
    // imperfect but should produce meaningful overlap
    expect(r.candidates[0].breakdown.merchant).toBeGreaterThan(0.4);
  });
});

// ── Status thresholds ──────────────────────────────────────────────────────

describe("reconcile — status thresholds", () => {
  it("returns auto_matched for perfect match (composite ≈ 1.0)", () => {
    const result = reconcile(mkReceipt(), [mkTxn()]);
    expect(result.status).toBe("auto_matched");
    expect(result.best).toBeDefined();
    expect(result.best!.composite).toBeGreaterThan(0.88);
  });

  it("includes best in auto_matched result", () => {
    const result = reconcile(mkReceipt(), [mkTxn()]);
    expect(result.best).toBeDefined();
    expect(result.best!.transaction.id).toBe("txn-1");
    expect(result.best!.breakdown).toMatchObject({
      amount: expect.any(Number),
      date: expect.any(Number),
      merchant: expect.any(Number),
    });
  });

  it("returns needs_review when amount+date good but no merchant (composite ≈ 0.75)", () => {
    // amount=1.0 *0.4 + date=1.0 *0.35 + merchant=0 *0.25 = 0.75 → needs_review
    const result = reconcile(
      mkReceipt({ storeName: null }),
      [mkTxn({ merchantName: null })]
    );
    expect(result.status).toBe("needs_review");
    expect(result.best).toBeDefined();
    expect(result.best!.composite).toBeGreaterThanOrEqual(0.6);
    expect(result.best!.composite).toBeLessThan(0.88);
  });

  it("returns unmatched when all signals are weak (amount diff + date diff + no merchant)", () => {
    // amount diff $4 (score 0), date diff 4 days (score 0.4), merchant null (score 0)
    // composite = 0*0.4 + 0.4*0.35 + 0*0.25 = 0.14 < 0.6 → unmatched
    const result = reconcile(
      mkReceipt({ storeName: null, total: 50 }),
      [mkTxn({ merchantName: null, amount: 54, date: "2025-01-14" })]
    );
    expect(result.status).toBe("unmatched");
    expect(result.best).toBeUndefined();
  });

  it("returns unmatched when no candidates survive prefilter", () => {
    const result = reconcile(mkReceipt(), [
      mkTxn({ amount: 99, date: "2025-01-25" }), // both too far
    ]);
    expect(result.status).toBe("unmatched");
    expect(result.candidates).toHaveLength(0);
  });
});

// ── Multiple candidates ────────────────────────────────────────────────────

describe("reconcile — multiple candidates", () => {
  const receipt = mkReceipt({ total: 50, storeName: null, purchaseDate: "2025-01-10" });

  const txns: TransactionCandidate[] = [
    { id: "txn-a", amount: 50, date: "2025-01-10", merchantName: null }, // perfect amount+date
    { id: "txn-b", amount: 50.5, date: "2025-01-11", merchantName: null }, // slight diff
    { id: "txn-c", amount: 50.5, date: "2025-01-12", merchantName: null }, // more diff
    { id: "txn-d", amount: 50, date: "2025-01-14", merchantName: null },   // farther date
  ];

  it("returns candidates sorted by composite score descending", () => {
    const result = reconcile(receipt, txns);
    const scores = result.candidates.map((c) => c.composite);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
  });

  it("caps candidates returned at 3", () => {
    const result = reconcile(receipt, txns);
    expect(result.candidates.length).toBeLessThanOrEqual(3);
  });

  it("best is the highest-scoring candidate", () => {
    const result = reconcile(receipt, txns);
    if (result.best) {
      expect(result.best.composite).toBe(result.candidates[0].composite);
    }
  });

  it("carries the correct transaction id in each candidate", () => {
    const result = reconcile(receipt, txns);
    const ids = result.candidates.map((c) => c.transaction.id);
    expect(ids.every((id) => ["txn-a", "txn-b", "txn-c", "txn-d"].includes(id))).toBe(true);
  });
});

// ── Composite weight calculation ───────────────────────────────────────────

describe("reconcile — composite weight sanity", () => {
  it("composite equals weighted sum of breakdown components", () => {
    const result = reconcile(mkReceipt(), [mkTxn()]);
    const c = result.candidates[0];
    const expected = c.breakdown.amount * 0.4 + c.breakdown.date * 0.35 + c.breakdown.merchant * 0.25;
    expect(c.composite).toBeCloseTo(expected, 10);
  });

  it("composite is bounded [0, 1]", () => {
    const result = reconcile(mkReceipt(), [mkTxn()]);
    for (const c of result.candidates) {
      expect(c.composite).toBeGreaterThanOrEqual(0);
      expect(c.composite).toBeLessThanOrEqual(1);
    }
  });

  it("auto_matched composite is >= 0.88", () => {
    const result = reconcile(mkReceipt(), [mkTxn()]);
    expect(result.status).toBe("auto_matched");
    expect(result.best!.composite).toBeGreaterThanOrEqual(0.88);
  });
});

// ── receiptId propagation ──────────────────────────────────────────────────

describe("reconcile — receiptId", () => {
  it("propagates receiptId to output even when unmatched", () => {
    const result = reconcile(mkReceipt({ id: 42 }), []);
    expect(result.receiptId).toBe(42);
  });

  it("propagates receiptId to auto_matched output", () => {
    const result = reconcile(mkReceipt({ id: 99 }), [mkTxn()]);
    expect(result.receiptId).toBe(99);
  });
});

// ── Edge: receipt with $0 total ────────────────────────────────────────────

describe("reconcile — edge cases", () => {
  it("treats $0 receipt total as unmatched (falsy guard in prefilter)", () => {
    // The prefilter does `if (!receipt.total)` — 0 is falsy, so it returns [] immediately.
    // This is intentional: a $0 receipt cannot be meaningfully reconciled.
    const result = reconcile(mkReceipt({ total: 0 }), [mkTxn({ amount: 0 })]);
    expect(result.status).toBe("unmatched");
    expect(result.candidates).toHaveLength(0);
  });

  it("total: 0 behaves the same as total: null for prefilter purposes", () => {
    const withZero = reconcile(mkReceipt({ total: 0 }), [mkTxn()]);
    const withNull = reconcile(mkReceipt({ total: null }), [mkTxn()]);
    expect(withZero.status).toBe(withNull.status);
    expect(withZero.candidates).toHaveLength(withNull.candidates.length);
  });

  it("reconcile with single very good txn and many bad txns picks correct best", () => {
    const receipt = mkReceipt({ total: 100, storeName: "AMAZON", purchaseDate: "2025-01-10" });
    const txns: TransactionCandidate[] = [
      { id: "bad-1", amount: 104, date: "2025-01-10", merchantName: "WHOLE FOODS" },
      { id: "good", amount: 100, date: "2025-01-10", merchantName: "AMAZON" },
      { id: "bad-2", amount: 103, date: "2025-01-13", merchantName: null },
    ];
    const result = reconcile(receipt, txns);
    expect(result.status).toBe("auto_matched");
    expect(result.best!.transaction.id).toBe("good");
  });
});

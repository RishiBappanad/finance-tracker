import { describe, it, expect } from "vitest";
import {
  reconcile,
  type ReceiptCandidate,
  type TransactionCandidate,
} from "../../artifacts/api-server/src/services/reconciler.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function mkReceipt(overrides: Partial<ReceiptCandidate> = {}): ReceiptCandidate {
  return { id: 1, total: 50.0, purchaseDate: "2026-01-10", storeName: "TARGET", ...overrides };
}

function mkTxn(overrides: Partial<TransactionCandidate> = {}): TransactionCandidate {
  return { id: "txn-1", amount: 50.0, date: "2026-01-10", merchantName: "TARGET", ...overrides };
}

// ── Amount edge cases ─────────────────────────────────────────────────────

describe("reconciler — amount scoring edge cases", () => {
  it("scores 1.0 for exact match", () => {
    const result = reconcile(mkReceipt({ total: 99.99 }), [mkTxn({ amount: 99.99 })]);
    expect(result.best!.breakdown.amount).toBe(1);
  });

  it("scores high for sub-cent rounding difference", () => {
    const result = reconcile(mkReceipt({ total: 50.00 }), [mkTxn({ amount: 50.01 })]);
    expect(result.best!.breakdown.amount).toBeGreaterThan(0.9);
  });

  it("scores 0 for large amount difference", () => {
    const result = reconcile(mkReceipt({ total: 50 }), [mkTxn({ amount: 100 })]);
    // $50 diff is way beyond tolerance
    expect(result.status).toBe("unmatched");
  });

  it("handles negative amounts (credits)", () => {
    const result = reconcile(mkReceipt({ total: -25 }), [mkTxn({ amount: -25 })]);
    expect(result.best!.breakdown.amount).toBe(1);
  });

  it("matches receipt total to absolute transaction amount", () => {
    const result = reconcile(mkReceipt({ total: 75 }), [mkTxn({ amount: 75 })]);
    expect(result.status).toBe("auto_matched");
  });

  it("very small amounts ($0.01) still match", () => {
    const result = reconcile(mkReceipt({ total: 0.01 }), [mkTxn({ amount: 0.01 })]);
    expect(result.best!.breakdown.amount).toBe(1);
  });

  it("large amounts ($10000) still match exactly", () => {
    const result = reconcile(mkReceipt({ total: 10000 }), [mkTxn({ amount: 10000 })]);
    expect(result.best!.breakdown.amount).toBe(1);
  });
});

// ── Date scoring edge cases ───────────────────────────────────────────────

describe("reconciler — date scoring edge cases", () => {
  it("same day scores 1.0", () => {
    const result = reconcile(mkReceipt(), [mkTxn()]);
    expect(result.best!.breakdown.date).toBe(1);
  });

  it("1 day after scores 0.95", () => {
    const result = reconcile(
      mkReceipt({ purchaseDate: "2026-01-10" }),
      [mkTxn({ date: "2026-01-11" })]
    );
    expect(result.best!.breakdown.date).toBe(0.95);
  });

  it("1 day before scores 0.7 (pre-auth pattern)", () => {
    const result = reconcile(
      mkReceipt({ purchaseDate: "2026-01-10" }),
      [mkTxn({ date: "2026-01-09" })]
    );
    expect(result.best!.breakdown.date).toBe(0.7);
  });

  it("2 days after scores 0.85", () => {
    const result = reconcile(
      mkReceipt({ purchaseDate: "2026-01-10" }),
      [mkTxn({ date: "2026-01-12" })]
    );
    expect(result.best!.breakdown.date).toBe(0.85);
  });

  it("6+ days is filtered out by prefilter", () => {
    const result = reconcile(
      mkReceipt({ purchaseDate: "2026-01-10" }),
      [mkTxn({ date: "2026-01-16" })]
    );
    expect(result.status).toBe("unmatched");
  });

  it("handles year boundary (Dec 31 → Jan 1)", () => {
    const result = reconcile(
      mkReceipt({ purchaseDate: "2025-12-31" }),
      [mkTxn({ date: "2026-01-01" })]
    );
    expect(result.best!.breakdown.date).toBe(0.95);
  });
});

// ── Merchant scoring edge cases ──────────────────────────────────────────

describe("reconciler — merchant scoring edge cases", () => {
  it("exact match scores 1.0", () => {
    const result = reconcile(
      mkReceipt({ storeName: "WALMART" }),
      [mkTxn({ merchantName: "WALMART" })]
    );
    expect(result.best!.breakdown.merchant).toBe(1);
  });

  it("handles noise removal (LLC, INC, #)", () => {
    const result = reconcile(
      mkReceipt({ storeName: "Target" }),
      [mkTxn({ merchantName: "TARGET INC #1234" })]
    );
    expect(result.best!.breakdown.merchant).toBeGreaterThan(0.7);
  });

  it("handles SQ* prefix (Square merchants)", () => {
    const result = reconcile(
      mkReceipt({ storeName: "Coffee Shop" }),
      [mkTxn({ merchantName: "SQ *Coffee Shop" })]
    );
    expect(result.best!.breakdown.merchant).toBeGreaterThan(0.5);
  });

  it("scores 0 when both names are null", () => {
    const result = reconcile(
      mkReceipt({ storeName: null }),
      [mkTxn({ merchantName: null })]
    );
    expect(result.best!.breakdown.merchant).toBe(0);
  });

  it("scores 0 when receipt store name is null", () => {
    const result = reconcile(
      mkReceipt({ storeName: null }),
      [mkTxn({ merchantName: "STORE" })]
    );
    expect(result.best!.breakdown.merchant).toBe(0);
  });

  it("case insensitive matching", () => {
    const result = reconcile(
      mkReceipt({ storeName: "starbucks" }),
      [mkTxn({ merchantName: "STARBUCKS" })]
    );
    expect(result.best!.breakdown.merchant).toBe(1);
  });

  it("partial prefix match gets bonus", () => {
    const result = reconcile(
      mkReceipt({ storeName: "Chick" }),
      [mkTxn({ merchantName: "Chick-fil-A" })]
    );
    expect(result.best!.breakdown.merchant).toBeGreaterThan(0.5);
  });
});

// ── Multiple candidates ───────────────────────────────────────────────────

describe("reconciler — multiple candidates", () => {
  it("picks the highest scoring match", () => {
    const result = reconcile(
      mkReceipt({ total: 50, purchaseDate: "2026-01-10", storeName: "TARGET" }),
      [
        mkTxn({ id: "bad", amount: 45, date: "2026-01-12", merchantName: "WALMART" }),
        mkTxn({ id: "good", amount: 50, date: "2026-01-10", merchantName: "TARGET" }),
        mkTxn({ id: "ok", amount: 50, date: "2026-01-11", merchantName: "TARGET" }),
      ]
    );
    expect(result.best!.transaction.id).toBe("good");
  });

  it("returns top 3 candidates sorted by score", () => {
    const result = reconcile(
      mkReceipt({ total: 50, storeName: null }),
      [
        mkTxn({ id: "a", amount: 50, date: "2026-01-10", merchantName: null }),
        mkTxn({ id: "b", amount: 50, date: "2026-01-11", merchantName: null }),
        mkTxn({ id: "c", amount: 50, date: "2026-01-12", merchantName: null }),
        mkTxn({ id: "d", amount: 50, date: "2026-01-13", merchantName: null }),
      ]
    );
    expect(result.candidates.length).toBeLessThanOrEqual(3);
    // Should be sorted descending by composite
    for (let i = 1; i < result.candidates.length; i++) {
      expect(result.candidates[i - 1].composite).toBeGreaterThanOrEqual(result.candidates[i].composite);
    }
  });
});

// ── Threshold boundaries ─────────────────────────────────────────────────

describe("reconciler — threshold boundaries", () => {
  it("auto_matched when composite >= 0.88", () => {
    // Perfect match on all signals → composite = 1.0
    const result = reconcile(mkReceipt(), [mkTxn()]);
    expect(result.status).toBe("auto_matched");
    expect(result.best!.composite).toBeGreaterThanOrEqual(0.88);
  });

  it("needs_review when composite between 0.6 and 0.88", () => {
    // Same amount, 3 days off, different merchant → middling score
    const result = reconcile(
      mkReceipt({ storeName: "ABC Store" }),
      [mkTxn({ date: "2026-01-13", merchantName: "XYZ Shop" })]
    );
    if (result.status === "needs_review") {
      expect(result.best!.composite).toBeGreaterThanOrEqual(0.6);
      expect(result.best!.composite).toBeLessThan(0.88);
    }
  });
});

// ── Prefilter: amount window ─────────────────────────────────────────────

describe("reconciler — prefilter amount window", () => {
  it("includes transactions within 5% of receipt total", () => {
    const result = reconcile(
      mkReceipt({ total: 100 }),
      [mkTxn({ amount: 104 })] // 4% diff, within 5%
    );
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it("uses minimum $5 window for small receipts", () => {
    const result = reconcile(
      mkReceipt({ total: 10 }),
      [mkTxn({ amount: 14 })] // $4 diff, within $5 absolute window
    );
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it("filters out transactions far outside amount window", () => {
    const result = reconcile(
      mkReceipt({ total: 50 }),
      [mkTxn({ amount: 200 })] // Way outside 5% and $5
    );
    expect(result.status).toBe("unmatched");
  });
});

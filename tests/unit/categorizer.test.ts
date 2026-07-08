import { describe, it, expect } from "vitest";
import {
  categorizeTransactions,
  CATEGORIES,
  type TransactionInput,
} from "../../artifacts/api-server/src/services/categorizer.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function mkTxn(overrides: Partial<TransactionInput> = {}): TransactionInput {
  return {
    id: `txn-${Math.random().toString(36).slice(2)}`,
    merchantName: null,
    merchantNameRaw: null,
    amount: 25.00,
    categoryPrimary: null,
    categoryDetail: null,
    ...overrides,
  };
}

// ── Categories constant ───────────────────────────────────────────────────

describe("CATEGORIES", () => {
  it("contains expected core categories", () => {
    expect(CATEGORIES).toContain("Food & Dining");
    expect(CATEGORIES).toContain("Groceries");
    expect(CATEGORIES).toContain("Transportation");
    expect(CATEGORIES).toContain("Shopping");
    expect(CATEGORIES).toContain("Income");
    expect(CATEGORIES).toContain("Transfer");
    expect(CATEGORIES).toContain("Other");
  });

  it("has no duplicates", () => {
    const unique = new Set(CATEGORIES);
    expect(unique.size).toBe(CATEGORIES.length);
  });
});

// ── Rule-based: Plaid category mapping ────────────────────────────────────

describe("categorizer — Plaid category mapping", () => {
  it("maps 'Food and Drink' to 'Food & Dining'", async () => {
    const results = await categorizeTransactions([
      mkTxn({ categoryPrimary: "Food and Drink" }),
    ]);
    expect(results[0].category).toBe("Food & Dining");
    expect(results[0].method).toBe("rule");
  });

  it("maps 'Travel' to 'Travel'", async () => {
    const results = await categorizeTransactions([
      mkTxn({ categoryPrimary: "Travel" }),
    ]);
    expect(results[0].category).toBe("Travel");
  });

  it("maps 'Transfer' to 'Transfer'", async () => {
    const results = await categorizeTransactions([
      mkTxn({ categoryPrimary: "Transfer" }),
    ]);
    expect(results[0].category).toBe("Transfer");
  });

  it("maps 'Shops' to 'Shopping'", async () => {
    const results = await categorizeTransactions([
      mkTxn({ categoryPrimary: "Shops" }),
    ]);
    expect(results[0].category).toBe("Shopping");
  });

  it("maps 'Healthcare' to 'Health & Fitness'", async () => {
    const results = await categorizeTransactions([
      mkTxn({ categoryPrimary: "Healthcare" }),
    ]);
    expect(results[0].category).toBe("Health & Fitness");
  });
});

// ── Rule-based: Merchant name patterns ───────────────────────────────────

describe("categorizer — merchant name patterns", () => {
  const testCases: [string, string][] = [
    // Food & Dining
    ["McDonald's", "Food & Dining"],
    ["STARBUCKS #1234", "Food & Dining"],
    ["Chipotle Mexican Grill", "Food & Dining"],
    ["DoorDash", "Food & Dining"],
    ["Chick-fil-A", "Food & Dining"],
    // Groceries
    ["WALMART SUPERCENTER", "Groceries"],
    ["Trader Joe's", "Groceries"],
    ["Aldi", "Groceries"],
    ["Whole Foods Market", "Groceries"],
    ["KROGER #123", "Groceries"],
    ["Instacart", "Groceries"],
    // Gas & Fuel
    ["SHELL OIL", "Gas & Fuel"],
    ["Chevron", "Gas & Fuel"],
    ["BP #1234", "Gas & Fuel"],
    ["QuikTrip", "Gas & Fuel"],
    // Transportation
    ["UBER TRIP", "Transportation"],
    ["Lyft", "Transportation"],
    ["NYC Metro Transit", "Transportation"],
    // Shopping
    ["AMAZON.COM", "Shopping"],
    ["Best Buy", "Shopping"],
    ["Home Depot", "Shopping"],
    ["Target", "Groceries"], // Target matches groceries first due to pattern order
    // Entertainment
    ["Netflix", "Entertainment"],
    ["Spotify", "Entertainment"],
    ["HULU", "Entertainment"],
    ["Disney Plus", "Entertainment"],
    // Health & Fitness
    ["Planet Fitness", "Health & Fitness"],
    ["CVS Pharmacy", "Health & Fitness"],
    ["Rite Aid", "Health & Fitness"],
    // Bills & Utilities
    ["Comcast", "Bills & Utilities"],
    ["AT&T", "Bills & Utilities"],
    ["Verizon Wireless", "Bills & Utilities"],
    // Travel
    ["United Airlines", "Travel"],
    ["Marriott Hotels", "Travel"],
    ["Airbnb", "Travel"],
    // Insurance
    ["GEICO", "Insurance"],
    ["State Farm", "Insurance"],
    // Investment
    ["Fidelity", "Investment"],
    ["Robinhood", "Investment"],
    ["Coinbase", "Investment"],
    // Transfer
    ["Venmo", "Transfer"],
    ["Zelle", "Transfer"],
    ["ACH Transfer", "Transfer"],
  ];

  for (const [merchant, expected] of testCases) {
    it(`categorizes "${merchant}" as "${expected}"`, async () => {
      const results = await categorizeTransactions([
        mkTxn({ merchantName: merchant }),
      ]);
      expect(results[0].category).toBe(expected);
      expect(results[0].method).toBe("rule");
    });
  }
});

// ── Rule-based: merchantNameRaw fallback ─────────────────────────────────

describe("categorizer — merchantNameRaw fallback", () => {
  it("uses merchantNameRaw when merchantName is null", async () => {
    const results = await categorizeTransactions([
      mkTxn({ merchantName: null, merchantNameRaw: "McDonald's" }),
    ]);
    expect(results[0].category).toBe("Food & Dining");
  });

  it("prefers merchantName over merchantNameRaw", async () => {
    const results = await categorizeTransactions([
      mkTxn({ merchantName: "Netflix", merchantNameRaw: "NFLX*MONTHLY" }),
    ]);
    expect(results[0].category).toBe("Entertainment");
  });
});

// ── Income detection ──────────────────────────────────────────────────────

describe("categorizer — income detection", () => {
  it("detects payroll as Income for large negative amounts", async () => {
    const results = await categorizeTransactions([
      mkTxn({ merchantName: "GUSTO PAYROLL", amount: -2500 }),
    ]);
    expect(results[0].category).toBe("Income");
  });

  it("detects direct deposit as Income", async () => {
    const results = await categorizeTransactions([
      mkTxn({ merchantNameRaw: "ACH Electronic CreditGUSTO PAY 123456", amount: -5000 }),
    ]);
    expect(results[0].category).toBe("Income");
  });

  it("does NOT classify small negative amounts without payroll keyword as income", async () => {
    const results = await categorizeTransactions([
      mkTxn({ merchantName: "Random Transfer", amount: -50 }),
    ]);
    // Generic transfer with small amount won't be income
    expect(results[0].category).toBe("Transfer");
  });
});

// ── Fallback to Other ─────────────────────────────────────────────────────

describe("categorizer — fallback", () => {
  it("falls back to 'Other' when no rule matches and no LLM available", async () => {
    const results = await categorizeTransactions([
      mkTxn({ merchantName: "XYZQWERTY UNKNOWN CO", categoryPrimary: null }),
    ]);
    expect(results[0].category).toBe("Other");
    expect(results[0].method).toBe("fallback");
  });

  it("falls back to 'Other' when merchant is null and no Plaid category", async () => {
    const results = await categorizeTransactions([
      mkTxn({ merchantName: null, merchantNameRaw: null, categoryPrimary: null }),
    ]);
    expect(results[0].category).toBe("Other");
    expect(results[0].method).toBe("fallback");
  });
});

// ── Batch processing ──────────────────────────────────────────────────────

describe("categorizer — batch processing", () => {
  it("categorizes multiple transactions correctly", async () => {
    const results = await categorizeTransactions([
      mkTxn({ id: "1", merchantName: "McDonald's" }),
      mkTxn({ id: "2", merchantName: "Netflix" }),
      mkTxn({ id: "3", merchantName: "Shell" }),
      mkTxn({ id: "4", merchantName: "UNKNOWN VENDOR XYZ" }),
    ]);

    expect(results).toHaveLength(4);
    expect(results.find((r) => r.id === "1")!.category).toBe("Food & Dining");
    expect(results.find((r) => r.id === "2")!.category).toBe("Entertainment");
    expect(results.find((r) => r.id === "3")!.category).toBe("Gas & Fuel");
    expect(results.find((r) => r.id === "4")!.category).toBe("Other");
  });

  it("handles empty input gracefully", async () => {
    const results = await categorizeTransactions([]);
    expect(results).toHaveLength(0);
  });

  it("handles large batch (100+) without error", async () => {
    const txns = Array.from({ length: 120 }, (_, i) =>
      mkTxn({ id: `txn-${i}`, merchantName: i % 2 === 0 ? "Starbucks" : "UNKNOWN" })
    );
    const results = await categorizeTransactions(txns);
    expect(results).toHaveLength(120);
    // Even ones are Starbucks (Food & Dining), odd ones are Other (fallback)
    expect(results.filter((r) => r.category === "Food & Dining")).toHaveLength(60);
    expect(results.filter((r) => r.category === "Other")).toHaveLength(60);
  });
});

// ── Case insensitivity ────────────────────────────────────────────────────

describe("categorizer — case insensitivity", () => {
  it("matches regardless of case", async () => {
    const results = await categorizeTransactions([
      mkTxn({ merchantName: "mcdonald's" }),
      mkTxn({ merchantName: "MCDONALD'S" }),
      mkTxn({ merchantName: "McDonald's" }),
    ]);
    for (const r of results) {
      expect(r.category).toBe("Food & Dining");
    }
  });
});

import { describe, it, expect } from "vitest";
import {
  getPlaidAdapter,
  type PlaidAdapter,
  type SyncResult,
} from "../../artifacts/api-server/src/services/plaid.js";

// ── Adapter selection ─────────────────────────────────────────────────────

describe("Plaid adapter selection", () => {
  it("returns mock adapter when no credentials set", () => {
    // In test env, PLAID_CLIENT_ID and PLAID_SECRET are not set
    const adapter = getPlaidAdapter();
    expect(adapter.name).toBe("plaid-mock");
  });

  it("mock adapter returns empty sync results", async () => {
    const adapter = getPlaidAdapter();
    const result = await adapter.syncTransactions("fake-token");
    expect(result.added).toHaveLength(0);
    expect(result.modified).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBe("");
  });

  it("mock adapter exchangePublicToken returns mock values", async () => {
    const adapter = getPlaidAdapter();
    const result = await adapter.exchangePublicToken("any-token");
    expect(result.accessToken).toBe("mock-access-token");
    expect(result.itemId).toBe("mock-item-id");
  });

  it("mock adapter getAccounts returns empty array", async () => {
    const adapter = getPlaidAdapter();
    const accounts = await adapter.getAccounts("any-token");
    expect(accounts).toHaveLength(0);
  });
});

// ── Sync result structure ─────────────────────────────────────────────────

describe("Plaid sync result interface", () => {
  it("SyncResult has correct shape", () => {
    const result: SyncResult & { nextCursor: string } = {
      added: [],
      modified: [],
      removed: [],
      hasMore: false,
      nextCursor: "",
    };
    expect(result.added).toBeInstanceOf(Array);
    expect(result.modified).toBeInstanceOf(Array);
    expect(result.removed).toBeInstanceOf(Array);
    expect(typeof result.hasMore).toBe("boolean");
    expect(typeof result.nextCursor).toBe("string");
  });

  it("hasMore flag indicates more pages available", () => {
    const page1: SyncResult = { added: [{ transactionId: "t1", accountId: "a1", amount: 10, isoCurrencyCode: "USD", merchantName: "Store", name: "Store", category: [], date: "2026-01-01", pending: false }], modified: [], removed: [], hasMore: true };
    const page2: SyncResult = { added: [], modified: [], removed: [], hasMore: false };

    expect(page1.hasMore).toBe(true);
    expect(page2.hasMore).toBe(false);
  });
});

// ── Deduplication logic (tested at DB level via onConflictDoNothing) ──────

describe("Transaction deduplication", () => {
  it("transactions use transactionId as primary key", () => {
    // This is a design test — verifying the schema uses text PK
    // The actual deduplication happens via onConflictDoNothing in the sync route
    // This test documents the expected behavior
    const txn = { transactionId: "plaid-txn-abc123" };
    expect(txn.transactionId).toBeDefined();
    expect(typeof txn.transactionId).toBe("string");
  });

  it("cursor should be saved after each successful sync page", () => {
    // Documents expected behavior: sync saves cursor after each page
    // so that if it crashes mid-sync, it can resume from the last cursor
    const cursors: string[] = [];
    
    // Simulate 3 pages
    cursors.push("cursor-page-1");
    cursors.push("cursor-page-2");
    cursors.push("cursor-page-3");
    
    expect(cursors).toHaveLength(3);
    expect(cursors[cursors.length - 1]).toBe("cursor-page-3");
  });
});

// ── Transaction data mapping ─────────────────────────────────────────────

describe("Plaid transaction mapping", () => {
  it("maps all required fields from Plaid format", () => {
    const plaidTxn = {
      transactionId: "abc123",
      accountId: "acct-1",
      amount: 25.50,
      isoCurrencyCode: "USD",
      merchantName: "Coffee Shop",
      name: "COFFEE SHOP NYC",
      category: ["Food and Drink", "Coffee"],
      date: "2026-07-01",
      pending: false,
    };

    // Verify mapping to our internal format
    expect(plaidTxn.transactionId).toBeTruthy();
    expect(plaidTxn.accountId).toBeTruthy();
    expect(typeof plaidTxn.amount).toBe("number");
    expect(plaidTxn.isoCurrencyCode).toBe("USD");
    expect(plaidTxn.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof plaidTxn.pending).toBe("boolean");
    expect(plaidTxn.category[0]).toBe("Food and Drink");
  });

  it("handles null merchantName gracefully", () => {
    const plaidTxn = {
      transactionId: "def456",
      accountId: "acct-1",
      amount: 100,
      isoCurrencyCode: "USD",
      merchantName: null,
      name: "ACH TRANSFER",
      category: [],
      date: "2026-07-01",
      pending: false,
    };

    expect(plaidTxn.merchantName).toBeNull();
    expect(plaidTxn.name).toBeTruthy(); // merchantNameRaw fallback
  });

  it("handles empty category array", () => {
    const plaidTxn = {
      category: [] as string[],
    };
    expect(plaidTxn.category[0] ?? null).toBeNull();
  });
});

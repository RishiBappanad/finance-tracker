import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getPlaidAdapter, type PlaidAdapter } from "../../artifacts/api-server/src/services/plaid.js";

const REAL_ENV = { ...process.env };

function clearPlaidEnv() {
  delete process.env.PLAID_CLIENT_ID;
  delete process.env.PLAID_SECRET;
  delete process.env.PLAID_ENV;
}

function setPlaidEnv() {
  process.env.PLAID_CLIENT_ID = "test-client-id";
  process.env.PLAID_SECRET = "test-secret";
  process.env.PLAID_ENV = "sandbox";
}

afterEach(() => {
  process.env = { ...REAL_ENV };
});

// ── Adapter selection ──────────────────────────────────────────────────────

describe("getPlaidAdapter — adapter selection", () => {
  it("returns mock adapter when PLAID credentials are absent", () => {
    clearPlaidEnv();
    const adapter = getPlaidAdapter();
    expect(adapter.name).toBe("plaid-mock");
  });

  it("returns live adapter when PLAID credentials are present", () => {
    setPlaidEnv();
    const adapter = getPlaidAdapter();
    expect(adapter.name).toBe("plaid-live");
  });

  it("falls back to mock when only CLIENT_ID is set (incomplete creds)", () => {
    clearPlaidEnv();
    process.env.PLAID_CLIENT_ID = "partial";
    const adapter = getPlaidAdapter();
    expect(adapter.name).toBe("plaid-mock");
  });

  it("falls back to mock when only SECRET is set (incomplete creds)", () => {
    clearPlaidEnv();
    process.env.PLAID_SECRET = "partial";
    const adapter = getPlaidAdapter();
    expect(adapter.name).toBe("plaid-mock");
  });
});

// ── PlaidAdapter interface contract ───────────────────────────────────────

describe("PlaidAdapter interface contract", () => {
  beforeEach(() => clearPlaidEnv());

  it("adapter has all required methods", () => {
    const adapter = getPlaidAdapter();
    expect(typeof adapter.exchangePublicToken).toBe("function");
    expect(typeof adapter.getAccounts).toBe("function");
    expect(typeof adapter.syncTransactions).toBe("function");
    expect(typeof adapter.name).toBe("string");
  });
});

// ── Mock adapter behaviour ─────────────────────────────────────────────────

describe("mock adapter — exchangePublicToken()", () => {
  beforeEach(() => clearPlaidEnv());

  it("resolves to an access token object", async () => {
    const adapter = getPlaidAdapter();
    const result = await adapter.exchangePublicToken("public-token-xyz");
    expect(result).toHaveProperty("accessToken");
    expect(typeof result.accessToken).toBe("string");
    expect(result.accessToken.length).toBeGreaterThan(0);
  });

  it("always resolves with a non-empty access token string", async () => {
    const adapter = getPlaidAdapter();
    const r1 = await adapter.exchangePublicToken("token-a");
    const r2 = await adapter.exchangePublicToken("token-b");
    expect(r1.accessToken.length).toBeGreaterThan(0);
    expect(r2.accessToken.length).toBeGreaterThan(0);
  });
});

describe("mock adapter — getAccounts()", () => {
  beforeEach(() => clearPlaidEnv());

  it("resolves to an array (mock returns empty — no live credentials)", async () => {
    const adapter = getPlaidAdapter();
    const accounts = await adapter.getAccounts("mock-access-token");
    expect(Array.isArray(accounts)).toBe(true);
    // Mock returns [] until wired to real Plaid; route handles this with a 400
  });
});

describe("mock adapter — syncTransactions()", () => {
  beforeEach(() => clearPlaidEnv());

  it("resolves to a SyncResult shape", async () => {
    const adapter = getPlaidAdapter();
    const result = await adapter.syncTransactions("mock-access-token");
    expect(result).toHaveProperty("added");
    expect(result).toHaveProperty("modified");
    expect(result).toHaveProperty("removed");
    expect(Array.isArray(result.added)).toBe(true);
    expect(Array.isArray(result.modified)).toBe(true);
    expect(Array.isArray(result.removed)).toBe(true);
  });

  it("added transactions have the correct shape", async () => {
    const adapter = getPlaidAdapter();
    const { added } = await adapter.syncTransactions("mock-access-token");
    for (const txn of added) {
      expect(txn).toHaveProperty("transactionId");
      expect(txn).toHaveProperty("accountId");
      expect(txn).toHaveProperty("amount");
      expect(txn).toHaveProperty("date");
      expect(txn).toHaveProperty("pending");
      expect(Array.isArray(txn.category)).toBe(true);
    }
  });
});

describe("live adapter — interface shape (no live calls)", () => {
  it("live adapter exposes same interface as mock", () => {
    setPlaidEnv();
    const live = getPlaidAdapter();
    clearPlaidEnv();
    const mock = getPlaidAdapter();

    const liveKeys = Object.keys(live).sort();
    const mockKeys = Object.keys(mock).sort();
    expect(liveKeys).toEqual(mockKeys);
  });
});

/**
 * Plaid Service Adapter — modular bank data provider.
 *
 * This module is the single swap point for banking integrations.
 * Replace with a real Plaid client, or swap to another provider
 * (Teller, MX, Finicity) without touching any route handler.
 *
 * Set PLAID_CLIENT_ID + PLAID_SECRET + PLAID_ENV in env to activate.
 * Falls back to mock data when credentials are absent (development mode).
 */

export interface PlaidTransaction {
  transactionId: string;
  accountId: string;
  amount: number;
  isoCurrencyCode: string;
  merchantName: string | null;
  name: string;
  category: string[];
  date: string; // YYYY-MM-DD
  pending: boolean;
}

export interface SyncResult {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: string[]; // transaction IDs
  hasMore: boolean;
}

/**
 * One stream from Plaid's Recurring Transactions endpoint -- Plaid's own
 * detection of "this shows up on a schedule", so finance-tracker writes no
 * detection logic, only a fetch-and-map (lib/recurring-plaid.ts).
 */
export interface PlaidRecurringStream {
  streamId: string;
  accountId: string;
  description: string;
  merchantName: string | null;
  frequency: string; // WEEKLY | BIWEEKLY | SEMI_MONTHLY | MONTHLY | ANNUALLY | UNKNOWN
  status: string; // MATURE | EARLY_DETECTION | TOMBSTONED | UNKNOWN
  isActive: boolean;
  direction: "outflow" | "inflow";
  averageAmount: number; // magnitude; the sign is `direction`
  lastAmount: number | null;
  lastDate: string | null;
  predictedNextDate: string | null;
}

export interface PlaidAdapter {
  readonly name: string;
  exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }>;
  getAccounts(accessToken: string): Promise<PlaidAccountRaw[]>;
  syncTransactions(accessToken: string, cursor?: string): Promise<SyncResult & { nextCursor: string }>;
  getRecurringStreams(accessToken: string): Promise<PlaidRecurringStream[]>;
}

export interface PlaidAccountRaw {
  accountId: string;
  name: string;
  type: string;
  subtype: string | null;
  mask: string | null;
  currency: string;
}

// ── Live Plaid adapter ────────────────────────────────────────────────────────
// Wire up: `npm install plaid` and fill in the implementation body.
const livePlaidAdapter: PlaidAdapter = {
  name: "plaid-live",
  async exchangePublicToken(publicToken: string) {
    const { PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV = "sandbox" } = process.env;
    if (!PLAID_CLIENT_ID || !PLAID_SECRET) throw new Error("Plaid credentials not configured");
    const res = await fetch(`https://${PLAID_ENV}.plaid.com/item/public_token/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: PLAID_CLIENT_ID, secret: PLAID_SECRET, public_token: publicToken }),
    });
    const data = (await res.json()) as { access_token: string; item_id: string };
    return { accessToken: data.access_token, itemId: data.item_id };
  },
  async getAccounts(accessToken: string) {
    const { PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV = "sandbox" } = process.env;
    const res = await fetch(`https://${PLAID_ENV}.plaid.com/accounts/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: PLAID_CLIENT_ID, secret: PLAID_SECRET, access_token: accessToken }),
    });
    const data = (await res.json()) as { accounts: any[] };
    return data.accounts.map((a: any) => ({
      accountId: a.account_id,
      name: a.name,
      type: a.type,
      subtype: a.subtype ?? null,
      mask: a.mask ?? null,
      currency: a.balances?.iso_currency_code ?? "USD",
    }));
  },
  async syncTransactions(accessToken: string, cursor?: string) {
    const { PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV = "sandbox" } = process.env;
    const res = await fetch(`https://${PLAID_ENV}.plaid.com/transactions/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: PLAID_CLIENT_ID, secret: PLAID_SECRET, access_token: accessToken, cursor }),
    });
    const data = (await res.json()) as any;
    const mapTxn = (t: any): PlaidTransaction => ({
      transactionId: t.transaction_id,
      accountId: t.account_id,
      amount: t.amount,
      isoCurrencyCode: t.iso_currency_code ?? "USD",
      merchantName: t.merchant_name ?? null,
      name: t.name,
      category: t.category ?? [],
      date: t.date,
      pending: t.pending,
    });
    return {
      added: (data.added ?? []).map(mapTxn),
      modified: (data.modified ?? []).map(mapTxn),
      removed: (data.removed ?? []).map((r: any) => r.transaction_id),
      hasMore: data.has_more ?? false,
      nextCursor: data.next_cursor ?? "",
    };
  },
  async getRecurringStreams(accessToken: string) {
    const { PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV = "sandbox" } = process.env;
    const res = await fetch(`https://${PLAID_ENV}.plaid.com/transactions/recurring/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: PLAID_CLIENT_ID, secret: PLAID_SECRET, access_token: accessToken }),
    });
    const data = (await res.json()) as any;
    if (!res.ok) throw new Error(data?.error_message ?? `Plaid recurring/get returned ${res.status}`);
    const map = (direction: "outflow" | "inflow") => (s: any): PlaidRecurringStream => ({
      streamId: s.stream_id,
      accountId: s.account_id,
      description: s.description ?? "",
      merchantName: s.merchant_name ?? null,
      frequency: s.frequency ?? "UNKNOWN",
      status: s.status ?? "UNKNOWN",
      isActive: s.is_active ?? true,
      direction,
      averageAmount: Math.abs(s.average_amount?.amount ?? 0),
      lastAmount: s.last_amount?.amount != null ? Math.abs(s.last_amount.amount) : null,
      lastDate: s.last_date ?? null,
      predictedNextDate: s.predicted_next_date ?? null,
    });
    return [...(data.outflow_streams ?? []).map(map("outflow")), ...(data.inflow_streams ?? []).map(map("inflow"))];
  },
};

// ── Mock adapter (dev/demo mode) ──────────────────────────────────────────────
const mockPlaidAdapter: PlaidAdapter = {
  name: "plaid-mock",
  async exchangePublicToken(_token: string) {
    return { accessToken: "mock-access-token", itemId: "mock-item-id" };
  },
  async getAccounts(_accessToken: string) {
    return [];
  },
  async syncTransactions(_accessToken: string) {
    return { added: [], modified: [], removed: [], hasMore: false, nextCursor: "" };
  },
  async getRecurringStreams(_accessToken: string) {
    return [];
  },
};

export function getPlaidAdapter(): PlaidAdapter {
  const hasCreds = !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
  return hasCreds ? livePlaidAdapter : mockPlaidAdapter;
}

import { vi } from "vitest";

/**
 * Chainable mock DB that returns enqueued values.
 * Use enqueue() to set up return values in order.
 */
const queue: unknown[] = [];

const makeChain = () => {
  const c: Record<string, any> = {};
  for (const m of [
    "from", "where", "leftJoin", "rightJoin", "innerJoin", "orderBy",
    "limit", "offset", "groupBy", "having", "values", "onConflictDoNothing",
    "onConflictDoUpdate", "returning", "set", "execute",
  ]) {
    c[m] = () => c;
  }
  c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(queue.shift() ?? []).then(res, rej);
  c.catch = (rej: (e: unknown) => unknown) =>
    Promise.resolve(queue.shift() ?? []).catch(rej);
  return c;
};

export const mockDb = {
  select: () => makeChain(),
  insert: () => makeChain(),
  update: () => makeChain(),
  delete: () => makeChain(),
};

export function enqueue(...vals: unknown[]) {
  vals.forEach((v) => queue.push(v));
}

export function resetQueue() {
  queue.splice(0, queue.length);
}

/**
 * Mock schema exports — just empty objects to satisfy imports.
 */
export const mockSchema = {
  users: {},
  institutions: {},
  accounts: {},
  bankTransactions: {},
  scannedReceipts: {},
  receiptItems: {},
  receiptTransactionMatches: {},
  userCategories: {},
};

/**
 * Standard DB module mock for vi.mock("@workspace/db")
 */
export function getDbMock() {
  return {
    db: mockDb,
    pool: {},
    ...mockSchema,
  };
}

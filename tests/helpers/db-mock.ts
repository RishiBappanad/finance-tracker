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
    "onConflictDoUpdate", "returning", "set", "execute", "$dynamic",
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
 * Mocks for lib/db/src/user-scoping.ts's real exports -- routes now import
 * these from @workspace/db, so a mocked @workspace/db module needs its own
 * stand-ins or every route that imports them gets `undefined` and throws.
 * Like the rest of this mock, these ignore their real query-filtering
 * behavior entirely (see this file's own top comment) -- joinTransactionOwnership
 * just continues the chain via the mock's own no-op innerJoin, and
 * ownedByUser returns an inert marker instead of a real SQL condition.
 * Real filtering behavior is verified separately, against a live database,
 * by tests/integration/user-scoping-live.test.ts.
 */
function joinTransactionOwnership(qb: any) {
  return qb.innerJoin().innerJoin();
}

function ownedByUser(userId: number) {
  return { __mockCondition: "ownedByUser", userId };
}

/**
 * Mock for lib/db/src/domain-events.ts's logDomainEvent() -- same reasoning
 * as joinTransactionOwnership/ownedByUser above: routes call this as a
 * fire-and-forget side effect (no route branches on its return value), so a
 * no-op stand-in is sufficient and, critically, does NOT touch the mock
 * queue -- the real implementation calls db.insert(domainEvents) internally,
 * which would silently consume a queue slot meant for the route's own next
 * real query if this mock just delegated to mockDb instead of no-opping.
 */
async function logDomainEvent(): Promise<void> {}

/**
 * Standard DB module mock for vi.mock("@workspace/db")
 */
export function getDbMock() {
  return {
    db: mockDb,
    pool: {},
    ...mockSchema,
    joinTransactionOwnership,
    ownedByUser,
    logDomainEvent,
  };
}

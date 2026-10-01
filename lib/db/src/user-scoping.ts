import { eq } from "drizzle-orm";
import type { PgSelect } from "drizzle-orm/pg-core";
import { accounts } from "./schema/accounts";
import { institutions } from "./schema/institutions";
import { bankTransactions } from "./schema/bank_transactions";

/**
 * Joins a bankTransactions-based query through accounts -> institutions,
 * the join every route needs to scope bank_transactions to the calling
 * user (bank_transactions has no userId column of its own -- ownership
 * only exists via this join chain). The single place this join is defined,
 * used by routes/transactions.ts, routes/dashboard.ts, routes/matches.ts,
 * routes/events.ts, and services/receipt-matcher.ts -- hand-copying it at
 * each call site is exactly how a new one ends up added without it, or
 * with it subtly wrong; having one place means a fix or an audit only has
 * to happen once.
 *
 * Only performs the join -- callers still supply their own `.where()`
 * (combining `ownedByUser(userId)` below with whatever other conditions
 * that call site needs via `and(...)`), since each call site's filters
 * differ and Drizzle's `.where()` replaces rather than merges.
 *
 * Takes any query already at `.select(...).from(bankTransactions)` and
 * returns it with both joins applied, regardless of the caller's own
 * `.select()` column shape -- via Drizzle's dynamic query builder, so
 * callers must call `.$dynamic()` themselves right after `.from(...)`
 * before passing the query in (required for TypeScript to accept a
 * concrete query into this generic helper; Drizzle's own docs recommend
 * this same pattern for exactly this kind of reusable query builder).
 */
export function joinTransactionOwnership<T extends PgSelect>(qb: T) {
  return qb
    .innerJoin(accounts, eq(bankTransactions.accountId, accounts.id))
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id));
}

/** The ownership condition itself, for callers to fold into their own `and(...)` list. */
export function ownedByUser(userId: number) {
  return eq(institutions.userId, userId);
}

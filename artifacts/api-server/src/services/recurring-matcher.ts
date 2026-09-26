/**
 * Pairs a recurring item's occurrence with the real bank transaction that
 * satisfied it -- the same amount/date/merchant idea as reconciler.ts (which
 * pairs receipts with transactions), reusing its merchant scorer, but with the
 * rules a forecast needs: the date is a WINDOW rather than one day, the amount is
 * optional (a recurring chore has none), and money-in never matches money-out.
 *
 * Pure -- callers load the candidate transactions and decide what to persist.
 */
import { scoreMerchant } from "./reconciler.js";
import { addDays, type Window } from "../lib/recurrence.js";

export interface OccurrenceToMatch {
  expectedAmount: number | null; // signed like bank_transactions.amount
  merchantHint: string; // what the merchant should look like (the item's hint, else its label)
  window: Window;
}

export interface TransactionToMatch {
  id: string;
  amount: number;
  date: string;
  merchantName: string | null;
}

export interface RecurringMatchScore {
  transaction: TransactionToMatch;
  composite: number;
  breakdown: { amount: number | null; date: number; merchant: number };
}

/** A transaction may post a day outside the window (banks post late); that's a weaker match, not a miss. */
export const POSTING_SLACK_DAYS = 1;
export const AUTO_MATCH_THRESHOLD = 0.8;
/** However well everything else lines up, an unrelated merchant is not the same recurring thing. */
export const MIN_MERCHANT_SCORE = 0.5;

export function scoreDateAgainstWindow(txnDate: string, window: Window): number {
  if (txnDate >= window.start && txnDate <= window.end) return 1;
  if (txnDate >= addDays(window.start, -POSTING_SLACK_DAYS) && txnDate <= addDays(window.end, POSTING_SLACK_DAYS)) return 0.7;
  return 0;
}

/** null when the item has no expected amount (that signal is simply absent, not zero). */
export function scoreAmountAgainstExpected(expected: number | null, actual: number): number | null {
  if (expected === null) return null;
  if (Math.sign(expected) !== Math.sign(actual) && expected !== 0) return 0; // money in vs. money out
  const diff = Math.abs(Math.abs(actual) - Math.abs(expected));
  const exactBand = Math.max(1, Math.abs(expected) * 0.05);
  if (diff <= exactBand) return 1;
  const looseBand = Math.max(3, Math.abs(expected) * 0.15);
  if (diff <= looseBand) return 0.7 * (1 - (diff - exactBand) / (looseBand - exactBand));
  return 0;
}

export function scoreTransaction(occurrence: OccurrenceToMatch, txn: TransactionToMatch): RecurringMatchScore | null {
  const date = scoreDateAgainstWindow(txn.date, occurrence.window);
  if (date === 0) return null;
  const merchant = scoreMerchant(occurrence.merchantHint, txn.merchantName);
  if (merchant < MIN_MERCHANT_SCORE) return null;
  const amount = scoreAmountAgainstExpected(occurrence.expectedAmount, txn.amount);
  if (amount === 0) return null;

  const composite = amount === null ? date * 0.3 + merchant * 0.7 : amount * 0.4 + date * 0.25 + merchant * 0.35;
  return { transaction: txn, composite, breakdown: { amount, date, merchant } };
}

/** The best-scoring transaction at or above the auto-match threshold, or null. Ties go to the one nearer the window. */
export function bestMatch(occurrence: OccurrenceToMatch, transactions: TransactionToMatch[]): RecurringMatchScore | null {
  let best: RecurringMatchScore | null = null;
  for (const txn of transactions) {
    const scored = scoreTransaction(occurrence, txn);
    if (!scored || scored.composite < AUTO_MATCH_THRESHOLD) continue;
    if (!best || scored.composite > best.composite || (scored.composite === best.composite && txn.date < best.transaction.date)) best = scored;
  }
  return best;
}

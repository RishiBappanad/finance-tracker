/**
 * Maps one Plaid recurring stream (services/plaid.ts) to a suggested recurring
 * item. Pure. Plaid does the detecting; this only translates, and returns null for
 * streams that shouldn't become suggestions (unknown cadence, tombstoned, inactive).
 */
import type { PlaidRecurringStream } from "../services/plaid.js";
import type { Cadence } from "./recurrence.js";

const CADENCE_BY_FREQUENCY: Record<string, Cadence> = {
  WEEKLY: "weekly",
  BIWEEKLY: "biweekly",
  SEMI_MONTHLY: "semi_monthly",
  MONTHLY: "monthly",
  ANNUALLY: "annually",
};

export interface SuggestedItem {
  source: "plaid";
  sourceId: string;
  label: string;
  merchantHint: string;
  cadence: Cadence;
  anchorDate: string;
  expectedAmount: number; // signed like bank_transactions.amount: outflow positive, inflow negative
  windowBeforeDays: number;
  windowAfterDays: number;
}

export function mapStreamToSuggestion(stream: PlaidRecurringStream): SuggestedItem | null {
  const cadence = CADENCE_BY_FREQUENCY[stream.frequency];
  if (!cadence || !stream.isActive) return null;
  if (stream.status !== "MATURE" && stream.status !== "EARLY_DETECTION") return null;
  const anchorDate = stream.predictedNextDate ?? stream.lastDate;
  if (!anchorDate) return null;

  const name = (stream.merchantName || stream.description || "").trim();
  if (!name) return null;

  const magnitude = stream.lastAmount ?? stream.averageAmount;
  // A short default range: banks post a day or two off, and a monthly bill's exact posting day varies.
  const after = cadence === "weekly" || cadence === "biweekly" ? 1 : 2;
  return {
    source: "plaid",
    sourceId: stream.streamId,
    label: name,
    merchantHint: name,
    cadence,
    anchorDate,
    expectedAmount: stream.direction === "inflow" ? -magnitude : magnitude,
    windowBeforeDays: 0,
    windowAfterDays: after,
  };
}

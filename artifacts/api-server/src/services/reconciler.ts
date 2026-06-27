/**
 * Reconciler Service — modular fuzzy-matching engine.
 *
 * Swap this module to change the matching algorithm without touching routes.
 * The exported interface is the only contract the rest of the app depends on.
 */

export interface ReceiptCandidate {
  id: number;
  total: number | null;
  purchaseDate: string | null;
  storeName: string | null;
}

export interface TransactionCandidate {
  id: string;
  amount: number;
  date: string;
  merchantName: string | null;
}

export interface ScoreBreakdown {
  amount: number;
  date: number;
  merchant: number;
}

export interface MatchCandidate {
  transaction: TransactionCandidate;
  composite: number;
  breakdown: ScoreBreakdown;
}

export type ReconcileStatus = "auto_matched" | "needs_review" | "unmatched";

export interface ReconcileOutcome {
  receiptId: number;
  status: ReconcileStatus;
  best?: MatchCandidate;
  candidates: MatchCandidate[];
}

// ── Constants (tunable without changing the interface) ───────────────────────
const WEIGHTS = { amount: 0.4, date: 0.35, merchant: 0.25 } as const;
const AUTO_CONFIRM_THRESHOLD = 0.88;
const SUGGEST_THRESHOLD = 0.6;
const DATE_WINDOW_DAYS = 5;
const AMOUNT_TOLERANCE_HARD = 0.5; // cents-level rounding
const AMOUNT_PREFILTER_PCT = 0.05; // 5% of receipt total
const AMOUNT_PREFILTER_ABS = 5.0; // minimum absolute window

// ── Normalisation helpers ────────────────────────────────────────────────────
const NOISE_RE = /\b(llc|inc|corp|co|store|sq\*|tst\*|sp\s)|[#*]+|\s{2,}/gi;

function normalizeName(name: string | null): string {
  if (!name) return "";
  return name
    .toUpperCase()
    .replace(NOISE_RE, " ")
    .replace(/\d{3,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Levenshtein distance (O(m*n)) — swappable with rapidfuzz via FFI if needed
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

// Token-set ratio (handles word-order variance + prefix truncation)
function tokenSetRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  const setA = new Set(a.split(" "));
  const setB = new Set(b.split(" "));
  const intersection = [...setA].filter((t) => setB.has(t)).join(" ");
  const onlyA = [...setA].filter((t) => !setB.has(t)).join(" ");
  const onlyB = [...setB].filter((t) => !setA.has(t)).join(" ");
  const s1 = intersection;
  const s2 = [intersection, onlyA].filter(Boolean).join(" ");
  const s3 = [intersection, onlyB].filter(Boolean).join(" ");
  const candidates = [
    [s1, s2],
    [s1, s3],
    [s2, s3],
  ];
  let best = 0;
  for (const [x, y] of candidates) {
    const maxLen = Math.max(x.length, y.length);
    if (maxLen === 0) continue;
    const ratio = 1 - levenshtein(x, y) / maxLen;
    if (ratio > best) best = ratio;
  }
  return best;
}

// ── Signal scorers ────────────────────────────────────────────────────────────
function scoreAmount(receiptTotal: number, txnAmount: number): number {
  const diff = Math.abs(Math.abs(receiptTotal) - Math.abs(txnAmount));
  if (diff === 0) return 1.0;
  if (diff <= AMOUNT_TOLERANCE_HARD) return 1.0 - (diff / AMOUNT_TOLERANCE_HARD) * 0.15;
  if (diff <= 2.0) return 0.5 - (diff / 2.0) * 0.4;
  return 0;
}

function scoreDate(receiptDate: string, txnDate: string): number {
  const rd = new Date(receiptDate).getTime();
  const td = new Date(txnDate).getTime();
  const delta = Math.round((td - rd) / 86_400_000);
  const table: Record<number, number> = { 0: 1.0, 1: 0.95, 2: 0.85, 3: 0.6, "-1": 0.7 };
  return table[delta] ?? Math.max(0, 1.0 - Math.abs(delta) * 0.15);
}

function scoreMerchant(storeName: string | null, merchantName: string | null): number {
  const a = normalizeName(storeName);
  const b = normalizeName(merchantName);
  if (!a || !b) return 0;
  let ratio = tokenSetRatio(a, b);
  if (b.startsWith(a.slice(0, 5)) || a.startsWith(b.slice(0, 5)))
    ratio = Math.min(1, ratio + 0.1);
  return ratio;
}

// ── Pre-filter ───────────────────────────────────────────────────────────────
function prefilter(
  receipt: ReceiptCandidate,
  transactions: TransactionCandidate[]
): TransactionCandidate[] {
  if (!receipt.total || !receipt.purchaseDate) return [];
  const amountWindow = Math.max(AMOUNT_PREFILTER_ABS, Math.abs(receipt.total) * AMOUNT_PREFILTER_PCT);
  const rd = new Date(receipt.purchaseDate).getTime();
  return transactions.filter((t) => {
    const dateDiff = Math.abs(
      Math.round((new Date(t.date).getTime() - rd) / 86_400_000)
    );
    const amountDiff = Math.abs(Math.abs(t.amount) - Math.abs(receipt.total!));
    return dateDiff <= DATE_WINDOW_DAYS && amountDiff <= amountWindow;
  });
}

// ── Main export ───────────────────────────────────────────────────────────────
export function reconcile(
  receipt: ReceiptCandidate,
  transactions: TransactionCandidate[]
): ReconcileOutcome {
  const candidates = prefilter(receipt, transactions);

  const scored: MatchCandidate[] = candidates.map((t) => {
    const breakdown: ScoreBreakdown = {
      amount: scoreAmount(receipt.total!, t.amount),
      date: scoreDate(receipt.purchaseDate!, t.date),
      merchant: scoreMerchant(receipt.storeName, t.merchantName),
    };
    return {
      transaction: t,
      composite:
        breakdown.amount * WEIGHTS.amount +
        breakdown.date * WEIGHTS.date +
        breakdown.merchant * WEIGHTS.merchant,
      breakdown,
    };
  });

  scored.sort((a, b) => b.composite - a.composite);

  if (scored.length === 0) return { receiptId: receipt.id, status: "unmatched", candidates: [] };
  const best = scored[0];
  if (best.composite >= AUTO_CONFIRM_THRESHOLD)
    return { receiptId: receipt.id, status: "auto_matched", best, candidates: scored.slice(0, 3) };
  if (best.composite >= SUGGEST_THRESHOLD)
    return { receiptId: receipt.id, status: "needs_review", best, candidates: scored.slice(0, 3) };
  return { receiptId: receipt.id, status: "unmatched", candidates: scored.slice(0, 3) };
}

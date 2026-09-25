/**
 * GET /context -- this tracker's self-description for consumers that need
 * to interpret its Event Contract rows without prior knowledge of it (an
 * LLM, a script, a generic UI). Shape and rules:
 * workspace-notes/contracts/EVENT_CONTRACT_SPEC.md, "GET /context".
 *
 * Pure functions, no I/O, so both are unit-testable without a database.
 * The category list is passed in (built-in constant + the caller's own
 * user_categories) so the description can't drift from what the routes
 * actually accept; only the prose is hand-written.
 */

export const CONTEXT_VERSION = 1;

interface MetadataKey {
  type: string;
  description: string;
}

interface OwnerTypeContext {
  description: string;
  actions: string[];
  amount: { meaning: string; unit: string; summable: boolean };
  metadata_keys: Record<string, MetadataKey>;
  notes: string;
}

export interface FinanceContext {
  context_version: number;
  tracker: "finance";
  description: string;
  background: string;
  owner_types: Record<string, OwnerTypeContext>;
  categories: { value: string; label: string; applies_to: string[] }[];
  occurrence_events: string[];
}

const CRUD = ["created", "updated", "deleted"];

export function buildContext(builtinCategories: readonly string[], customCategories: readonly string[]): FinanceContext {
  const seen = new Set<string>();
  const categories = [...builtinCategories, ...customCategories]
    .filter((c) => (seen.has(c) ? false : (seen.add(c), true)))
    .map((value) => ({ value, label: value, applies_to: ["transaction"] }));

  return {
    context_version: CONTEXT_VERSION,
    tracker: "finance",
    description: "A personal finance tracker: bank transactions (synced from Plaid or entered by hand), scanned receipts and their line items, and the matches linking receipts to transactions.",
    background:
      "Money spent shows up as `transaction` entities; positive `amount` is money leaving the account. " +
      "A `receipt` (with its `receipt_item` lines) describes the same purchase as a `transaction` in more detail, and a `receipt_transaction_match` links the two -- so receipts, items and matches must NEVER be summed together with transactions, that counts one purchase several times. " +
      "Every create/edit/delete of an entity is a row in the event log, so the raw log holds several rows for one entity. " +
      "Read with ?view=current to get one row per live entity in its latest state; use ?owner_type=transaction to ask about spending.",
    owner_types: {
      transaction: {
        description: "One bank transaction (Plaid-synced or manual).",
        actions: CRUD,
        amount: { meaning: "transaction amount in dollars; positive is money spent, negative is money received", unit: "usd", summable: true },
        metadata_keys: {
          merchantName: { type: "string|null", description: "Cleaned merchant name (same value as `label`)." },
          merchantNameRaw: { type: "string|null", description: "Merchant name as the bank reported it." },
          currency: { type: "string", description: "ISO currency code; defaults to USD." },
          pending: { type: "boolean", description: "True while the bank has not yet settled the transaction." },
          ignored: { type: "boolean", description: "True if the user hid it from reports (also surfaced as `hidden`)." },
        },
        notes: "`category` is the user's own category when set, otherwise Plaid's. `occurred_at` is the transaction's posted date.",
      },
      receipt: {
        description: "One scanned or entered receipt.",
        actions: CRUD,
        amount: { meaning: "receipt total in dollars", unit: "usd", summable: false },
        metadata_keys: {},
        notes: "Describes a purchase that usually also exists as a `transaction`; not additive with it.",
      },
      receipt_item: {
        description: "One line item on a receipt.",
        actions: CRUD,
        amount: { meaning: "line item price in dollars", unit: "usd", summable: false },
        metadata_keys: {},
        notes: "Part of its receipt's total, not additive with it.",
      },
      receipt_transaction_match: {
        description: "A link between a receipt and the transaction it corresponds to.",
        actions: CRUD,
        amount: { meaning: "the matched amount in dollars", unit: "usd", summable: false },
        metadata_keys: {},
        notes: "A relationship, not spending.",
      },
      account: {
        description: "A bank account the user connected or created.",
        actions: CRUD,
        amount: { meaning: "not meaningful; always 0", unit: "none", summable: false },
        metadata_keys: {},
        notes: "",
      },
      user_category: {
        description: "A spending category the user defined.",
        actions: CRUD,
        amount: { meaning: "not meaningful; always 0", unit: "none", summable: false },
        metadata_keys: {},
        notes: "",
      },
      goal: {
        description: "A spending goal (a saved comparison of spending against a target).",
        actions: ["met", "exceeded"],
        amount: { meaning: "the measured value at the moment of crossing, in dollars", unit: "usd", summable: false },
        metadata_keys: {},
        notes: "Occurrence events: emitted when a goal transitions into or out of compliance.",
      },
    },
    categories,
    occurrence_events: ["goal_met", "goal_exceeded"],
  };
}

/** Prompt-ready rendering of the same content, for `?format=markdown`, so
 * every LLM adapter doesn't reimplement it. */
export function renderContextMarkdown(ctx: FinanceContext): string {
  const lines: string[] = [`# ${ctx.tracker} tracker`, "", ctx.description, ""];
  if (ctx.background) lines.push(ctx.background, "");
  lines.push("## Entity types", "");
  for (const [name, o] of Object.entries(ctx.owner_types)) {
    lines.push(`### ${name}`, o.description, "");
    lines.push(`- Actions: ${o.actions.join(", ")}`);
    lines.push(`- \`amount\`: ${o.amount.meaning} (unit: ${o.amount.unit}; ${o.amount.summable ? "safe to sum" : "do NOT sum across rows"})`);
    for (const [key, k] of Object.entries(o.metadata_keys)) lines.push(`- metadata.${key} (${k.type}): ${k.description}`);
    if (o.notes) lines.push(`- Note: ${o.notes}`);
    lines.push("");
  }
  lines.push("## Categories", "", ctx.categories.map((c) => c.value).join(", "), "");
  if (ctx.occurrence_events.length) lines.push("## Occurrence events", "", ctx.occurrence_events.join(", "), "");
  return lines.join("\n");
}

/**
 * Transaction Categorization Service
 *
 * Priority:
 * 1. Rule-based (merchant name patterns + Plaid categories) — instant
 * 2. LLM — Gemini when GEMINI_API_KEY is set (the only LLM reachable from
 *    the deployed Cloud Run service), else Ollama for local dev — ~2-3s/batch
 * 3. Fallback to "Other"
 *
 * Set GEMINI_API_KEY to enable Gemini categorization (same key already
 * used by receipt-ocr.ts). Without it, falls back to OLLAMA_BASE_URL
 * (default http://localhost:11434) / OLLAMA_MODEL (default llama3.2:3b)
 * for local-only testing — Ollama isn't reachable from production.
 */

// Standard spending categories
export const CATEGORIES = [
  "Food & Dining",
  "Groceries",
  "Transportation",
  "Gas & Fuel",
  "Shopping",
  "Entertainment",
  "Health & Fitness",
  "Bills & Utilities",
  "Rent & Mortgage",
  "Insurance",
  "Travel",
  "Education",
  "Personal Care",
  "Gifts & Donations",
  "Income",
  "Transfer",
  "Fees & Charges",
  "Investment",
  "Other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export interface TransactionInput {
  id: string;
  merchantName: string | null;
  merchantNameRaw: string | null;
  amount: number;
  categoryPrimary: string | null;
  categoryDetail: string | null;
}

export interface CategorizationResult {
  id: string;
  category: Category;
  method: "rule" | "llm" | "fallback";
}

// ── Rule-based categorization ────────────────────────────────────────────────

// Plaid category mapping (primary category → our category)
const PLAID_CATEGORY_MAP: Record<string, Category> = {
  "Food and Drink": "Food & Dining",
  "Travel": "Travel",
  "Transportation": "Transportation",
  "Transfer": "Transfer",
  "Payment": "Transfer",
  "Recreation": "Entertainment",
  "Shops": "Shopping",
  "Service": "Bills & Utilities",
  "Healthcare": "Health & Fitness",
  "Community": "Gifts & Donations",
  "Bank Fees": "Fees & Charges",
  "Interest": "Income",
  "Tax": "Bills & Utilities",
};

// Merchant name patterns (case-insensitive)
const MERCHANT_PATTERNS: [RegExp, Category][] = [
  // Food & Dining
  [/\b(mcdonald|burger king|wendy|chick-fil-a|taco bell|subway|chipotle|panda express|popeyes|kfc|pizza hut|domino|papa john|starbucks|dunkin|panera|chili|applebee|olive garden|ihop|denny|waffle house|five guys|shake shack|in-n-out|whataburger|sonic|arby|jack in the box|del taco|wingstop|buffalo wild|raising cane|zaxby|jersey mike|jimmy john|firehouse sub|potbelly|noodles|grubhub|doordash|uber eat|postmates|seamless|caviar)\b/i, "Food & Dining"],
  // Groceries
  [/\b(walmart|target|costco|kroger|safeway|whole foods|trader joe|aldi|publix|h-e-b|wegman|sprout|food lion|giant|stop.?shop|meijer|winco|grocery|market basket|fresh market|piggly wiggly|save-a-lot|lidl|instacart|shipt)\b/i, "Groceries"],
  // Gas & Fuel
  [/\b(shell|chevron|exxon|mobil|bp|marathon|sunoco|citgo|valero|speedway|wawa|racetrac|quiktrip|circle k|sheetz|casey|pilot|love.?s|flying j|gas|fuel|petro)\b/i, "Gas & Fuel"],
  // Transportation
  [/\b(uber(?! eat)|lyft|taxi|cab|metro|transit|subway|bus|amtrak|parking|toll|ez.?pass)\b/i, "Transportation"],
  // Shopping
  [/\b(amazon|ebay|etsy|best buy|apple\.com|walmart\.com|nordstrom|macy|kohls|tj.?maxx|ross|marshalls|home depot|lowes|ikea|wayfair|bed bath|pottery barn|crate.?barrel|williams.?sonoma|gap|old navy|h&m|zara|nike|adidas|rei|dick.?s sporting)\b/i, "Shopping"],
  // Entertainment
  [/\b(netflix|hulu|disney|spotify|apple music|youtube|hbo|paramount|peacock|amc|regal|cinemark|xbox|playstation|steam|twitch|concert|ticket|live nation|stubhub|fandango)\b/i, "Entertainment"],
  // Health & Fitness
  [/\b(gym|fitness|planet fitness|la fitness|equinox|orangetheory|crossfit|peloton|cvs|walgreen|rite aid|pharmacy|doctor|dentist|hospital|clinic|urgent care|lab|quest diagnostics|labcorp)\b/i, "Health & Fitness"],
  // Bills & Utilities
  [/\b(electric|water|gas bill|utility|comcast|xfinity|at&t|verizon|t-mobile|sprint|spectrum|cox|centurylink|internet|cable|phone bill|waste management)\b/i, "Bills & Utilities"],
  // Rent & Mortgage
  [/\b(rent|mortgage|lease|property|hoa|homeowner)\b/i, "Rent & Mortgage"],
  // Insurance
  [/\b(insurance|geico|state farm|allstate|progressive|liberty mutual|usaa|farmers|nationwide)\b/i, "Insurance"],
  // Travel
  [/\b(airline|united|delta|american air|southwest|jetblue|spirit|frontier|hotel|marriott|hilton|hyatt|airbnb|vrbo|expedia|booking\.com|kayak|priceline|hertz|enterprise|avis|national car)\b/i, "Travel"],
  // Education
  [/\b(tuition|university|college|school|course|udemy|coursera|chegg|textbook)\b/i, "Education"],
  // Personal Care
  [/\b(salon|barber|spa|nail|hair|beauty|sephora|ulta|bath.?body)\b/i, "Personal Care"],
  // Gifts & Donations
  [/\b(donation|charity|church|tithe|gift|gofundme|paypal giving)\b/i, "Gifts & Donations"],
  // Income (negative amounts from Plaid = credit)
  [/\b(payroll|direct dep|paycheck|gusto|adp|salary|wage|dividend|refund)\b/i, "Income"],
  // Transfer
  [/\b(transfer|zelle|venmo|cash app|wire|ach|deposit|withdrawal|atm)\b/i, "Transfer"],
  // Fees & Charges
  [/\b(fee|overdraft|nsf|late charge|interest charge|annual fee|service charge)\b/i, "Fees & Charges"],
  // Investment
  [/\b(fidelity|vanguard|schwab|robinhood|etrade|ameritrade|coinbase|investment|brokerage|401k|ira)\b/i, "Investment"],
];

function categorizeByRules(txn: TransactionInput): Category | null {
  // 1. Check if it's income (negative amount in Plaid = money coming in)
  if (txn.amount < 0 && Math.abs(txn.amount) > 100) {
    const merchant = (txn.merchantName || txn.merchantNameRaw || "").toLowerCase();
    if (/payroll|direct dep|gusto|adp|salary|deposit/i.test(merchant)) {
      return "Income";
    }
  }

  // 2. Try Plaid's own category
  if (txn.categoryPrimary) {
    const mapped = PLAID_CATEGORY_MAP[txn.categoryPrimary];
    if (mapped) return mapped;
  }

  // 3. Try merchant name patterns
  const merchantText = txn.merchantName || txn.merchantNameRaw || "";
  if (!merchantText) return null;

  for (const [pattern, category] of MERCHANT_PATTERNS) {
    if (pattern.test(merchantText)) {
      return category;
    }
  }

  return null;
}

// ── LLM categorization ────────────────────────────────────────────────────

function buildCategorizationPrompt(transactions: TransactionInput[]): string {
  const txnList = transactions
    .map((t, i) => `${i + 1}. "${t.merchantName || t.merchantNameRaw || "Unknown"}" $${Math.abs(t.amount).toFixed(2)}`)
    .join("\n");

  return `Categorize each transaction into exactly one category from this list:
${CATEGORIES.join(", ")}

Transactions:
${txnList}

Respond with ONLY a JSON array of category strings in the same order, no explanation. Example: ["Food & Dining", "Shopping", "Other"]`;
}

function parseCategorizationResponse(text: string, transactions: TransactionInput[]): Map<string, Category> {
  const results = new Map<string, Category>();

  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return results;

  const categories: string[] = JSON.parse(match[0]);
  for (let i = 0; i < Math.min(categories.length, transactions.length); i++) {
    const cat = categories[i];
    if (CATEGORIES.includes(cat as Category)) {
      results.set(transactions[i].id, cat as Category);
    }
  }

  return results;
}

// Mirrors receipt-ocr.ts's Gemini adapter: same raw-REST-call style, same
// model/endpoint, same graceful-degradation contract (any failure returns
// an empty map rather than throwing, so the caller falls through to "Other").
async function categorizeByGemini(transactions: TransactionInput[]): Promise<Map<string, Category>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return new Map();

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildCategorizationPrompt(transactions) }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 500 },
        }),
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!response.ok) return new Map();

    const data = (await response.json()) as { candidates?: [{ content?: { parts?: [{ text?: string }] } }] };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return new Map();

    return parseCategorizationResponse(text, transactions);
  } catch {
    // Gemini unavailable, timed out, or malformed response — graceful degradation
    return new Map();
  }
}

async function categorizeByOllama(transactions: TransactionInput[]): Promise<Map<string, Category>> {
  const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  const model = process.env.OLLAMA_MODEL ?? "llama3.2:3b";

  try {
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: buildCategorizationPrompt(transactions),
        stream: false,
        options: { temperature: 0.1, num_predict: 500 },
      }),
      signal: AbortSignal.timeout(15000), // 15s timeout
    });

    if (!response.ok) return new Map();

    const data = (await response.json()) as { response: string };
    return parseCategorizationResponse(data.response.trim(), transactions);
  } catch {
    // Ollama unavailable or timed out — graceful degradation
    return new Map();
  }
}

// Gemini is preferred since it's the only LLM reachable from the deployed
// Cloud Run service (OLLAMA_BASE_URL has no route there) -- Ollama remains
// available as a local-dev-only fallback when no Gemini key is configured.
async function categorizeByLLM(transactions: TransactionInput[]): Promise<Map<string, Category>> {
  if (process.env.GEMINI_API_KEY) return categorizeByGemini(transactions);
  return categorizeByOllama(transactions);
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function categorizeTransactions(
  transactions: TransactionInput[]
): Promise<CategorizationResult[]> {
  const results: CategorizationResult[] = [];
  const needsLLM: TransactionInput[] = [];

  // Pass 1: Rule-based
  for (const txn of transactions) {
    const category = categorizeByRules(txn);
    if (category) {
      results.push({ id: txn.id, category, method: "rule" });
    } else {
      needsLLM.push(txn);
    }
  }

  // Pass 2: LLM for uncategorized (in batches of 20)
  if (needsLLM.length > 0) {
    const BATCH_SIZE = 20;
    for (let i = 0; i < needsLLM.length; i += BATCH_SIZE) {
      const batch = needsLLM.slice(i, i + BATCH_SIZE);
      const llmResults = await categorizeByLLM(batch);

      for (const txn of batch) {
        const category = llmResults.get(txn.id);
        if (category) {
          results.push({ id: txn.id, category, method: "llm" });
        } else {
          // Pass 3: Fallback
          results.push({ id: txn.id, category: "Other", method: "fallback" });
        }
      }
    }
  }

  return results;
}

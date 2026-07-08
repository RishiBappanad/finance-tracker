# Receipt Wallet — Finance Tracker

A personal finance tracker that connects to your bank accounts via [Plaid](https://plaid.com), lets you scan/upload receipts, and automatically matches receipts to bank transactions using fuzzy reconciliation — giving you a clear picture of where your money goes.

## Features

- **Bank Account Linking** — Connect checking/savings/credit accounts through Plaid's secure integration
- **Transaction Sync** — Automatically pull and categorize bank transactions
- **Receipt Scanning** — Upload receipt images; OCR extracts store name, date, totals, and line items
- **Smart Reconciliation** — Fuzzy-matching engine scores receipts against transactions by amount, date, and merchant name, auto-confirming high-confidence matches and flagging ambiguous ones for review
- **Dashboard** — Overview of accounts, recent transactions, and reconciliation status
- **Return Tracking** — Stores return window deadlines from receipts

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, Vite 7, TailwindCSS 4, Wouter (routing), TanStack Query |
| Backend | Express 5, Node.js |
| Database | PostgreSQL + Drizzle ORM |
| Banking | Plaid API (sandbox/production) |
| OCR | Tesseract / Ollama (pluggable adapters, currently stubbed) |
| Validation | Zod, OpenAPI spec + Orval codegen |
| Build | pnpm workspaces, esbuild (API bundle), Vite (frontend) |

## Project Structure

```
finance-tracker/
├── artifacts/
│   ├── receipt-wallet/     # React frontend (SPA)
│   └── api-server/         # Express API server
├── lib/
│   ├── db/                 # Drizzle schema & database connection
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-zod/            # Generated Zod validators
│   └── api-client-react/   # Generated React Query hooks
└── scripts/                # Dev utilities
```

## Getting Started

### Prerequisites

- Node.js >= 20
- pnpm >= 9
- PostgreSQL (local or hosted)

### Setup

```bash
# Install dependencies
pnpm install

# Set environment variables
cp .env.example .env
# Edit .env with your DATABASE_URL, PLAID_CLIENT_ID, PLAID_SECRET, etc.

# Push database schema
pnpm --filter @workspace/db run push

# Start the API server (port 5000)
pnpm --filter @workspace/api-server run dev

# Start the frontend (port 5173)
pnpm --filter @workspace/receipt-wallet run dev
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PORT` | Yes (API) | Port for the API server (default: 5000) |
| `PLAID_CLIENT_ID` | No* | Plaid API client ID |
| `PLAID_SECRET` | No* | Plaid API secret key |
| `PLAID_ENV` | No | `sandbox`, `development`, or `production` (default: `sandbox`) |

*If Plaid credentials are not set, the app runs in mock mode with no real bank data.

## Development

```bash
# Full typecheck across all packages
pnpm run typecheck

# Build everything
pnpm run build

# Regenerate API client hooks and Zod schemas from OpenAPI spec
pnpm --filter @workspace/api-spec run codegen

# Run API tests
pnpm --filter @workspace/api-server run test
```

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/healthz` | Health check |
| GET/POST | `/api/accounts` | List/link bank accounts |
| GET | `/api/transactions` | List synced bank transactions |
| GET/POST | `/api/receipts` | List/upload scanned receipts |
| GET | `/api/receipts/:id` | Receipt detail with line items |
| POST | `/api/reconcile` | Run reconciliation for a receipt |
| GET/POST | `/api/matches` | View/confirm receipt-transaction matches |
| GET | `/api/dashboard` | Aggregated dashboard data |

## How Reconciliation Works

The matching engine scores each candidate transaction against a receipt using three weighted signals:

1. **Amount (40%)** — How close is the transaction amount to the receipt total?
2. **Date (35%)** — How many days apart are the receipt date and transaction date?
3. **Merchant (25%)** — Token-set fuzzy string matching between store name and merchant name

Matches scoring ≥ 0.88 are auto-confirmed. Scores between 0.60–0.88 are flagged for manual review.

## License

MIT

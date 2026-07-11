FROM node:22-slim
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# Install dependencies (copy manifests first for better layer caching)
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY lib/db/package.json ./lib/db/
COPY lib/api-spec/package.json ./lib/api-spec/
COPY lib/api-zod/package.json ./lib/api-zod/
COPY lib/api-client-react/package.json ./lib/api-client-react/
COPY artifacts/api-server/package.json ./artifacts/api-server/
COPY artifacts/receipt-wallet/package.json ./artifacts/receipt-wallet/
COPY scripts/package.json ./scripts/

RUN pnpm install --frozen-lockfile

# Copy source
COPY tsconfig.json tsconfig.base.json ./
COPY lib/ ./lib/
COPY artifacts/ ./artifacts/
COPY scripts/ ./scripts/

# Build shared libs + API server (skip typecheck - build only)
RUN pnpm --filter @workspace/db run build 2>/dev/null || true
RUN pnpm --filter @workspace/api-zod run build 2>/dev/null || true
RUN pnpm --filter @workspace/api-client-react run build 2>/dev/null || true
RUN pnpm --filter @workspace/api-server run build

# Build the React frontend with proxy base path
ENV VITE_BASE_PATH=/finance/
ENV VITE_API_BASE=/finance
RUN pnpm --filter @workspace/receipt-wallet run build

# Move frontend output to /app/public (where app.ts expects it via process.cwd())
RUN mv /app/artifacts/receipt-wallet/dist/public /app/public

EXPOSE 3000
ENV PORT=3000
ENV NODE_ENV=production

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]

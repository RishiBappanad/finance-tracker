FROM node:22-slim
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# Install dependencies
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

# Build everything
RUN pnpm run build
RUN pnpm --filter @workspace/receipt-wallet run build

EXPOSE 3000
ENV PORT=3000
ENV NODE_ENV=production
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]

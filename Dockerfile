FROM node:22-slim AS base
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

RUN pnpm install

# Copy source
COPY tsconfig.json tsconfig.base.json ./
COPY lib/ ./lib/
COPY artifacts/ ./artifacts/
COPY scripts/ ./scripts/

# Build everything (libs + api-server + frontend)
RUN pnpm run build
RUN pnpm --filter @workspace/receipt-wallet run build

# Production image
FROM node:22-slim AS production
WORKDIR /app

COPY --from=base /app/artifacts/api-server/dist ./dist
COPY --from=base /app/artifacts/receipt-wallet/dist/public ./public
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/artifacts/api-server/package.json ./package.json

# Add a startup check
RUN echo '#!/bin/sh\necho "Starting app..."\nexec node --enable-source-maps ./dist/index.mjs' > /app/start.sh && chmod +x /app/start.sh

EXPOSE 3000
ENV PORT=3000
ENV NODE_ENV=production
CMD ["/app/start.sh"]

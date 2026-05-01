FROM node:22-alpine

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace manifests (for layer caching)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY apps/backend/package.json ./apps/backend/
# Copy prisma schema before install so the postinstall `prisma generate` succeeds
COPY apps/backend/prisma/ ./apps/backend/prisma/
COPY packages/shared/package.json ./packages/shared/
COPY packages/game-engine/package.json ./packages/game-engine/

# Install all workspace dependencies
# postinstall in apps/backend runs `prisma generate` — needs schema already present
RUN pnpm install --frozen-lockfile

# Copy all source after deps are cached
COPY apps/backend/src/ ./apps/backend/src/
COPY apps/backend/prisma.config.ts ./apps/backend/
COPY packages/shared/ ./packages/shared/
COPY packages/game-engine/ ./packages/game-engine/

ENV NODE_ENV=production
EXPOSE 3001

# Run from apps/backend so pnpm resolves tsx (and other deps) from its own node_modules
WORKDIR /app/apps/backend
CMD ["node", "--import", "tsx/esm", "src/server.ts"]

FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
RUN bun install --frozen-lockfile

# Copy source and build frontend
COPY . .
RUN bun run build

ENV REINS_DATA_DIR=/data
VOLUME /data

EXPOSE 3100
CMD ["bun", "packages/backend/src/index.ts"]

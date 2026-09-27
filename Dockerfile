FROM oven/bun:1 AS base
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package.json bun.lock ./
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
COPY packages/node/package.json packages/node/
RUN bun install --frozen-lockfile

# Copy source and build frontend
COPY . .
RUN bun run build

ENV REINS_DATA_DIR=/data
ENV HOME=/data
VOLUME /data

EXPOSE 3100
# Server and node run as separate processes under the supervisor (restarts a crashed node).
CMD ["bun", "packages/backend/src/supervisor.ts", "start"]

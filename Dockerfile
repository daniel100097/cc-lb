FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS build
WORKDIR /app
COPY . .
RUN bun run typecheck && bun run lint && bun run build

FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=8484 DB_PATH=/app/data/cc-lb.db CLAUDE_CONFIG_DIR=/app/data/claude CLAUDE_ACCOUNTS_DIR=/app/data/claude-accounts PATH=/app/node_modules/.bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends tmux && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
RUN bun node_modules/@anthropic-ai/claude-code/install.cjs
RUN claude --version
COPY src ./src
COPY scripts ./scripts
COPY --from=build /app/public ./public
RUN mkdir -p /app/data/claude /app/data/claude-accounts && chown -R bun:bun /app/data
VOLUME /app/data
EXPOSE 8484
HEALTHCHECK --interval=30s --timeout=3s CMD bun src/healthcheck.ts || exit 1
USER bun
CMD ["bun", "src/index.ts"]

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
ENV NODE_ENV=production PORT=8484 DB_PATH=/app/data/cc-lb.db
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY --from=build /app/public ./public
RUN mkdir -p /app/data
VOLUME /app/data
EXPOSE 8484
HEALTHCHECK --interval=30s --timeout=3s CMD bun src/healthcheck.ts || exit 1
CMD ["bun", "src/index.ts"]

# 05 — Docker & CI

## Build model

Two-stage Docker build: stage 1 builds the Vite frontend into `public/`, stage 2
is the Bun runtime serving both proxy + static SPA. Single image, single port.

## Dockerfile (multi-stage)

```dockerfile
# ---- frontend build ----
FROM oven/bun:1 AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/bun.lock ./
RUN bun install --frozen-lockfile
COPY frontend/ ./
RUN bun run build            # vite build → ../public

# ---- server deps ----
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- runtime ----
FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=8484 DB_PATH=/app/data/cc-lb.db
COPY --from=deps /app/node_modules ./node_modules
COPY src/ ./src/
COPY package.json ./
COPY --from=frontend /app/public ./public
RUN mkdir -p /app/data
VOLUME /app/data
EXPOSE 8484
HEALTHCHECK --interval=30s --timeout=3s CMD bun run src/healthcheck.ts || exit 1
CMD ["bun", "run", "src/index.ts"]
```

`bun:sqlite` is built into Bun — no native build step needed. Use `bun:1-slim` for
the runtime to keep the image small.

## docker-compose.yml

```yaml
services:
  cc-lb:
    image: ghcr.io/daniel100097/cc-lb:latest
    build: .
    ports:
      - "8484:8484"
    volumes:
      - ./data:/app/data          # SQLite persistence (holds the tokens!)
    environment:
      - PORT=8484
      - DB_PATH=/app/data/cc-lb.db
      # - DASHBOARD_PASSWORD=changeme   # optional, protects /api + dashboard
    restart: unless-stopped
```

Note in README: `data/` is the secret store (plaintext OAuth tokens) — lock down
file perms; don't expose port 8484 publicly without `DASHBOARD_PASSWORD` and/or a
network boundary.

## GitHub Actions — build & push to GHCR

`.github/workflows/docker.yml`:

```yaml
name: docker
on:
  push:
    branches: [main]
    tags: ["v*"]
  workflow_dispatch:
permissions:
  contents: read
  packages: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/metadata-action@v5
        id: meta
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=ref,event=branch
            type=semver,pattern={{version}}
            type=sha,format=short
            type=raw,value=latest,enable={{is_default_branch}}
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- Uses the built-in `GITHUB_TOKEN` — no extra secrets to configure.
- Image published to `ghcr.io/daniel100097/cc-lb`. Tags: branch name, semver on tag
  push, short SHA, and `latest` on main.
- GHA layer cache speeds up rebuilds.

## Local dev (no Docker)

- `bun run dev` → runs server with `--watch` on 8484.
- `cd frontend && bun run dev` → Vite dev server on 5173, proxying `/api` + `/v1`
  to 8484 (configure in `vite.config.ts` `server.proxy`).
- `bun run build` (root) → builds frontend into `public/`, then serve from Bun.

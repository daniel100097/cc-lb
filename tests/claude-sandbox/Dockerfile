FROM oven/bun:1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
RUN bun node_modules/@anthropic-ai/claude-code/install.cjs && node_modules/.bin/claude --version
COPY src ./src
COPY tests/claude-sandbox ./tests/claude-sandbox
USER bun
ENTRYPOINT ["bun", "tests/claude-sandbox/run.ts"]

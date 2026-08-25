# mona-agent — containerized device agent
# Non-root, minimal surface. Data (credentials, policy, audit, memory)
# lives in /home/mona/.mona-agent — mount a volume there.
#
# Build:  docker build -t mona-agent .
# Run:    docker compose up -d   (or see docker-compose.yml)

# ── Build stage: workspaces + production deps ────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/protocol/package.json packages/protocol/
COPY apps/desktop/package.json apps/desktop/
COPY packages packages
COPY apps apps
RUN npm ci --omit=dev --no-audit --no-fund

# ── Runtime stage ─────────────────────────────────────────────────
FROM node:20-alpine
ENV NODE_ENV=production \
    HOME=/home/mona \
    MONA_METRICS_PORT=4301
WORKDIR /app
COPY --from=build /app /app
RUN addgroup -S mona && adduser -S mona -G mona \
 && mkdir -p /home/mona/.mona-agent \
 && chown -R mona:mona /home/mona /app
USER mona
EXPOSE 4301
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4301/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "apps/desktop/bin/mona-agent.js"]
CMD ["start"]

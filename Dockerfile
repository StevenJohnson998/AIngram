FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript (domain/ and config/protocol.ts) → build/
# allowJs=true means .js files are also copied to build/
# This step is a no-op until .ts files exist, then it compiles them
RUN npx tsc 2>/dev/null || true

FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled TS output (when .ts files exist)
COPY --from=builder /app/build/ ./build/
# Copy JS source (still the main entry point)
COPY src/ ./src/
COPY migrations/ ./migrations/
COPY scripts/ ./scripts/
COPY docs/ ./docs/
COPY docker-entrypoint.sh ./

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --retries=3 --start-period=15s \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)throw 1})"

ENTRYPOINT ["./docker-entrypoint.sh"]

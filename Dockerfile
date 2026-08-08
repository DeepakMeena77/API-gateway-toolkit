# ── Stage 1: install production dependencies only ────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
# --omit=dev keeps the image lean; production code never needs Jest/etc.
RUN npm ci --omit=dev

# ── Stage 2: runtime image ────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# Run as a non-root user for security best practice
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy prod node_modules from the deps stage (not from the host)
COPY --from=deps /app/node_modules ./node_modules

# Copy only the source that the server actually needs
COPY src/ ./src/
COPY package.json ./

USER appuser

EXPOSE 3000

# Healthcheck: use Node itself so no extra tools needed in the image.
# /keys/tiers is a public, zero-cost endpoint.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "\
    const h = require('http');\
    h.get('http://localhost:3000/keys/tiers', r => process.exit(r.statusCode === 200 ? 0 : 1))\
      .on('error', () => process.exit(1));"

CMD ["node", "src/server.js"]

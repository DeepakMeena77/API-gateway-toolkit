# ── Stage 1: build the React app ─────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── Stage 2: serve with Nginx ─────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
# Custom nginx config: SPA fallback + proxy /analytics to the gateway
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

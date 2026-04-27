FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

# Compile TS and copy static web assets (tsc only handles .ts files)
RUN npm run build

# ── Runtime image ─────────────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Compiled JS + static dashboard
COPY --from=builder /app/dist ./dist

# Plugin source files — agent writes new plugins here at runtime,
# so this directory must also be bind-mounted in docker-compose.yml
COPY plugins/ ./plugins/

# config/, memory/, and logs/ are bind-mounted from the host at runtime.
# ensureConfigDefaults() creates settings.json and plugins.json on first boot
# if they don't exist in the mounted volume.

EXPOSE 3000

CMD ["node", "dist/index.js"]

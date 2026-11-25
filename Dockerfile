# Build stage: same base image as bookings_api. Compiles src/ to dist/ (server, migrations, scripts).
FROM node:24-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Run stage: production dependencies and dist/ only. No configuration or secrets are baked in:
# everything comes from the runtime environment (README "Production").
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist

# Uploaded files (FILES_DIR default). Mount a volume here so uploads survive redeploys.
RUN mkdir -p /assets/uploads && chown node:node /assets/uploads
USER node

EXPOSE 5010
# Migrations run separately, once per deploy: node dist/scripts/migrate.js up
CMD ["node", "dist/server.js"]

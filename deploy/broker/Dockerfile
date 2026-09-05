FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-alpine
ENV NODE_ENV=production
RUN addgroup -S purse && adduser -S purse -G purse
WORKDIR /app
COPY --from=build --chown=purse:purse /app/package.json ./package.json
COPY --from=build --chown=purse:purse /app/node_modules ./node_modules
COPY --from=build --chown=purse:purse /app/dist ./dist
USER purse
EXPOSE 8080 8081
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- "http://127.0.0.1:${PURSE_ADMIN_PORT:-8081}/healthz" || exit 1
CMD ["node", "dist/main.js"]

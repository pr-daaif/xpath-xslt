# --- Build de l'interface ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.mjs ./
COPY web ./web
RUN npm run build

# --- Image d'exécution ---
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY builtin ./builtin
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data/files && chown -R node:node /app/data
USER node
EXPOSE 3000
VOLUME /app/data
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/config >/dev/null || exit 1
CMD ["node", "server/index.js"]

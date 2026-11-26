# One container: Node API + WebSocket + the built React app, served from the same origin.

FROM node:22-slim AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-slim AS server
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production PORT=8080 WEB_DIST=/app/web/dist
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server/migrations ./migrations
COPY --from=server /app/server/dist ./dist
COPY --from=web /app/web/dist /app/web/dist
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]

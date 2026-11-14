# Node is pinned to an exact version on purpose. The server uses Node's built-in SQLite (node:sqlite), which Node still calls
# experimental, so a deploy must never move to a different Node by itself. To upgrade: change the version in BOTH lines below,
# deploy, and check Admin Panel > Overview (it shows the Node and SQLite versions that are running).
# ---- build the web client ----
FROM node:22.22.3-alpine3.24 AS build
WORKDIR /app
COPY package.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:22.22.3-alpine3.24
ENV NODE_ENV=production PORT=3001 DATA_DIR=/data
WORKDIR /app
COPY package.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm install --omit=dev --workspace server --no-audit --no-fund
COPY server server
COPY shared shared
COPY scripts scripts
COPY downloads downloads
COPY --from=build /app/client/dist client/dist
VOLUME /data
EXPOSE 3001
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.js"]

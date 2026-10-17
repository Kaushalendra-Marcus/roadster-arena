# Roadster Arena — one container: game server + built client site.
FROM node:22-alpine AS build
WORKDIR /app

# install exactly what the lockfile pins
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci

# build the client bundle
COPY . .
RUN npm run build -w client

# ---- runtime ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci --omit=dev

COPY packages/shared packages/shared
COPY server server
COPY --from=build /app/client/dist client/dist

EXPOSE 8080
WORKDIR /app/server
CMD ["npx", "tsx", "src/index.ts"]

# syntax=docker/dockerfile:1

# better-sqlite3 はネイティブモジュールのため、ビルド段でコンパイルできる環境を用意する。
# prebuild が使えればそのまま、使えなければここでビルドされる。
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# 本番依存だけを入れ直す。ネイティブモジュールを含むため、ビルド段と同じ環境で作る。
FROM deps AS prod-deps
WORKDIR /app
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    TZ=Asia/Tokyo \
    DATABASE_PATH=/data/four-keys.sqlite \
    PORT=3000
# DB ファイルは volume に置く。/data の所有者を node ユーザーに合わせておく。
RUN mkdir -p /data && chown -R node:node /data
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]

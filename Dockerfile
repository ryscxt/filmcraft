# syntax=docker/dockerfile:1.7
# FilmCraft for Barley: the FilmCraft web build behind a passkey sign-in, editing projects and
# media kept in a shared folder on the server. Build from the repository root:
#   docker build -t filmcraft-barley .   (deploy/barley/README.md)

# 1. FilmCraft's web build (wasm32 + wasm-bindgen + wasm-opt), as `cargo xtask web` makes it
FROM rust:1.95-bookworm AS wasm
RUN apt-get update && apt-get install -y --no-install-recommends binaryen brotli && rm -rf /var/lib/apt/lists/*
RUN rustup target add wasm32-unknown-unknown
# the CLI must be exactly the wasm-bindgen crate's version (xtask checks it)
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo install wasm-bindgen-cli --version 0.2.129 --locked
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target-cache \
    CARGO_TARGET_DIR=/src/target-cache cargo xtask web \
 && mkdir -p /dist && cp -R /src/target-cache/web/dist/. /dist/
# precompress: the server sends .br/.gz when the browser accepts them (13 MB wasm → ~5 MB)
RUN cd /dist && for f in *.wasm *.js *.html; do brotli -kq 11 "$f"; gzip -k9 "$f"; done

# 2. the host server's dependencies
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY deploy/barley/server/package.json deploy/barley/server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 3. runtime
FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data DIST_DIR=/srv/dist
WORKDIR /srv/app
COPY --from=deps /app/node_modules ./node_modules
COPY deploy/barley/server/package.json ./
COPY deploy/barley/server/src ./src
COPY deploy/barley/server/public ./public
COPY --from=wasm /dist /srv/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/main.ts"]

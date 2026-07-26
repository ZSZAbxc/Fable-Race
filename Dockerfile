# ─── Stage 1: 构建 client + 编译 server ───
FROM node:22-slim AS builder
RUN npm install -g pnpm@latest
WORKDIR /app

# 利用 Docker 缓存：先装依赖，源码改动了才重装
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json   packages/server/
COPY packages/client/package.json   packages/client/
RUN pnpm install --frozen-lockfile

# 复制全部源码
COPY . .

# 构建 client
RUN pnpm --filter @fable/client build

# 用 esbuild CLI 编译 server（显式 experimentalDecorators，绕过 tsx/esbuild 0.28 的 bug）
RUN npx esbuild packages/server/src/index.ts \
    --bundle \
    --platform=node \
    --target=es2021 \
    --format=esm \
    --packages=external \
    --tsconfig-raw='{"compilerOptions":{"experimentalDecorators":true,"useDefineForClassFields":false}}' \
    --outfile=packages/server/dist/server.mjs

# ─── Stage 2: 生产运行 ───
FROM node:22-slim

# pnpm + nginx
RUN apt-get update \
 && apt-get install -y nginx \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@latest

WORKDIR /app

# 只安装 server 运行时依赖（@colyseus/core 等）
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json   packages/server/
RUN pnpm install --frozen-lockfile --prod

# 复制 shared 源码（workspace 链接需要）和编译好的 server.mjs
COPY packages/shared/ packages/shared/
COPY --from=builder /app/packages/server/dist/server.mjs packages/server/dist/server.mjs

# 从 builder 复制 client 构建产物
COPY --from=builder /app/packages/client/dist /usr/share/nginx/html

# ── nginx：静态文件精确匹配，其余全部 proxy 到 Colyseus ──
RUN printf 'map $http_upgrade $connection_upgrade {\n\
    default upgrade;\n\
    \"\"      close;\n\
}\n\
server {\n\
    listen 5173;\n\
    location /assets/ {\n\
        root /usr/share/nginx/html;\n\
    }\n\
    location = /index.html {\n\
        root /usr/share/nginx/html;\n\
    }\n\
    location = / {\n\
        root /usr/share/nginx/html;\n\
        try_files /index.html =404;\n\
    }\n\
    location / {\n\
        proxy_pass http://127.0.0.1:2568;\n\
        proxy_http_version 1.1;\n\
        proxy_set_header Upgrade $http_upgrade;\n\
        proxy_set_header Connection $connection_upgrade;\n\
        proxy_set_header Host $host;\n\
        proxy_read_timeout 86400s;\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf \
 && rm -f /etc/nginx/sites-enabled/default

# ── 启动脚本 ──
RUN printf '#!/bin/sh\n\
LISTEN_PORT=${PORT:-5173}\n\
echo "[entry] nginx listening on $LISTEN_PORT"\n\
sed -i "s/listen 5173/listen $LISTEN_PORT/" /etc/nginx/conf.d/default.conf\n\
nginx\n\
echo "[entry] Colyseus starting on 2568"\n\
cd /app && PORT=2568 exec node packages/server/dist/server.mjs\n' > /entrypoint.sh \
 && chmod +x /entrypoint.sh

EXPOSE 5173

CMD ["/entrypoint.sh"]

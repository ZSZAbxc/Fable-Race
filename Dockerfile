# ─── Stage 1: 构建 client + 编译 server ───
FROM node:22-slim AS builder
RUN npm install -g pnpm@latest
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json   packages/server/
COPY packages/client/package.json   packages/client/
RUN pnpm install --frozen-lockfile

COPY . .

# 构建 client
RUN pnpm --filter @fable/client build

# esbuild 编译 server：shared 内联，只 external 原生/第三方包
RUN npx esbuild packages/server/src/index.ts \
    --bundle \
    --platform=node \
    --target=es2021 \
    --format=esm \
    --external:@colyseus/core \
    --external:@colyseus/schema \
    --external:@colyseus/ws-transport \
    --tsconfig-raw='{"compilerOptions":{"experimentalDecorators":true,"useDefineForClassFields":false}}' \
    --outfile=packages/server/dist/server.mjs

# ─── Stage 2: 生产运行 ───
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y nginx curl \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@latest

WORKDIR /app

# 只安装 server 运行时依赖（shared/package.json 让 pnpm 也能解析 rapier 等间接依赖）
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json   packages/server/
RUN pnpm install --frozen-lockfile

# 复制编译好的 server.mjs（shared 已内联，无需额外依赖）
COPY --from=builder /app/packages/server/dist/server.mjs packages/server/dist/server.mjs

# 复制 client 构建产物
COPY --from=builder /app/packages/client/dist /usr/share/nginx/html

# ── nginx：静态文件精确匹配，其余全部 proxy 到 Colyseus ──
RUN printf 'map $http_upgrade $connection_upgrade {\n\
    default upgrade;\n\
    \"\"      close;\n\
}\n\
server {\n\
    listen 5173;\n\
    root /usr/share/nginx/html;\n\
    location /assets/ { try_files $uri =404; }\n\
    location /sfx/    { try_files $uri =404; }\n\
    location = /index.html { }\n\
    location = / {\n\
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
cd /app && PORT=2568 node packages/server/dist/server.mjs &\n\
sleep 3\n\
echo "[diag] testing nginx -> Colyseus: POST /matchmake/create/race"\n\
curl -sv -X POST -H "Content-Type: application/json" -d "{}" http://127.0.0.1:$LISTEN_PORT/matchmake/create/race 2>&1 || true\n\
echo "[diag] testing direct Colyseus: POST /matchmake/create/race"\n\
curl -sv -X POST -H "Content-Type: application/json" -d "{}" http://127.0.0.1:2568/matchmake/create/race 2>&1 || true\n\
wait\n' > /entrypoint.sh \
 && chmod +x /entrypoint.sh

EXPOSE 5173

CMD ["/entrypoint.sh"]

# ─── Stage 1: 构建 client ───
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

# 复制全部源码并构建 client
COPY . .
RUN pnpm --filter @fable/client build

# ─── Stage 2: 生产运行 ───
FROM node:22-slim

# pnpm + tsx + nginx（静态文件服务 + WebSocket 代理）
RUN apt-get update \
 && apt-get install -y nginx \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@latest

WORKDIR /app

# 安装依赖（含 tsconfig.base.json，server tsconfig extends 它）
COPY pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json   packages/server/
RUN pnpm install --frozen-lockfile

# 复制运行时需要的源码
COPY packages/shared/ packages/shared/
COPY packages/server/ packages/server/

# esbuild 在 target>=ES2022 时忽略 experimentalDecorators 用 TC39 新式装饰器，
# 改 tsconfig.base.json target 为 ES2021 强制旧式（__decorate），兼容 @colyseus/schema。
RUN node -e "const f='tsconfig.base.json';const c=JSON.parse(require('fs').readFileSync(f,'utf8'));c.compilerOptions.target='ES2021';require('fs').writeFileSync(f,JSON.stringify(c,null,2)+'\n')"

# 从 builder 复制 client 构建产物
COPY --from=builder /app/packages/client/dist /usr/share/nginx/html

# ── nginx 配置：单端口同时服务 HTTP 与 WebSocket ──
#   /            → 静态文件（SPA fallback）
#   /matchmake/  → proxy 到 Colyseus（WebSocket upgrade）
RUN printf 'server {\n\
    listen 5173;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
    location /matchmake/ {\n\
        proxy_pass http://127.0.0.1:2568;\n\
        proxy_http_version 1.1;\n\
        proxy_set_header Upgrade $http_upgrade;\n\
        proxy_set_header Connection "upgrade";\n\
        proxy_set_header Host $host;\n\
    }\n\
    location / {\n\
        try_files $uri $uri/ /index.html;\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf \
 && rm -f /etc/nginx/sites-enabled/default

# ── 启动脚本：动态适配 CloudBase Run 的 PORT 环境变量 ──
RUN printf '#!/bin/sh\n\
LISTEN_PORT=${PORT:-5173}\n\
echo "[entry] nginx listening on $LISTEN_PORT"\n\
sed -i "s/listen 5173/listen $LISTEN_PORT/" /etc/nginx/conf.d/default.conf\n\
nginx\n\
echo "[entry] Colyseus starting on 2568"\n\
PORT=2568 exec pnpm --filter @fable/server start\n' > /entrypoint.sh \
 && chmod +x /entrypoint.sh

EXPOSE 5173

CMD ["/entrypoint.sh"]

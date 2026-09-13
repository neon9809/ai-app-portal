# AI应用门户 — 单镜像（Docker 形态；FPK 复用同一镜像）
# 构建：docker build -f deploy/docker/Dockerfile -t ai-app-portal:latest .
# 运行：见 docker-compose.yml；数据卷 /data（SQLite、证书、密钥、头像）

# ---------- 构建阶段 ----------
FROM node:22-alpine AS build
# better-sqlite3 无 musl 预编译时的源码编译依赖
RUN apk add --no-cache python3 make g++ libc6-compat
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
# 依次构建：shared（被 server/web 引用）→ server → web
RUN pnpm --filter @aap/shared build \
 && pnpm --filter @aap/server build \
 && pnpm --filter @aap/web build
# 产出自包含的服务端部署目录（含 workspace 依赖 @aap/shared）
RUN pnpm --filter @aap/server --prod deploy --legacy /out

# ---------- 运行阶段 ----------
FROM node:22-alpine
RUN apk add --no-cache tini
WORKDIR /out
# pnpm deploy 产物：package.json + node_modules（含 @aap/shared 构建产物）
COPY --from=build /out ./
# 服务端编译产物与迁移
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/server/drizzle ./drizzle
# 前端构建产物（server 生产托管 + SPA 兜底）
COPY --from=build /app/apps/web/dist ./public
# 开发指南与平台文档（右上角「开发指南」页数据源）
COPY --from=build /app/ai-app-portal-docs/app-develop.skill-v0.2.md ./assets/app-develop.skill-v0.2.md
COPY --from=build /app/README.md ./assets/README.md
COPY --from=build /app/ai-app-portal-docs/app-develop-internal.skill.md ./assets/app-develop-internal.skill.md

ENV NODE_ENV=production \
    DATA_DIR=/data \
    WEB_DIST=/out/public \
    PORT=8080 \
    HTTPS_PORT=8443 \
    TZ=Asia/Shanghai

VOLUME ["/data"]
EXPOSE 8080 8443
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]

# AI应用门户 — 单镜像（Docker 形态；FPK 复用同一镜像）
# 构建：docker build -f deploy/docker/Dockerfile -t ai-app-portal:latest .
# 运行：见 docker-compose.yml；数据卷 /data（SQLite、证书、密钥、头像）

# ---------- 构建阶段 ----------
# 构建（RUN --mount=type=cache 依赖 BuildKit，Docker 23+ 默认前端已支持）
FROM node:22-alpine AS build
# CN 网络优化：alpine 源与 npm registry 走国内镜像
RUN sed -i 's#https://dl-cdn.alpinelinux.org#https://mirrors.cloud.tencent.com#g' /etc/apk/repositories \
 && npm config set registry https://registry.npmmirror.com
# better-sqlite3 源码编译时 node-gyp 拉 Node 头文件也走国内镜像（否则 nodejs.org 直连常僵死）
ENV NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node \
    NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node
# better-sqlite3 无 musl 预编译时的源码编译依赖
RUN apk add --no-cache python3 make g++ libc6-compat
RUN corepack enable
WORKDIR /app
# manifest 先行：只声明不变时命中依赖层，源码变更不再触发全量拉包
# （轻量机小管道曾因每次全量下载数百 MB 包整机饿死，758ec46 事故）
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/aap-sdk/package.json packages/aap-sdk/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# pnpm store 走 BuildKit 缓存挂载：即使依赖层失效（lockfile 变更），命中部分免重下
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY packages ./packages
COPY apps ./apps
COPY ai-app-portal-docs ./ai-app-portal-docs
COPY README.md ./README.md
# 依次构建：shared（被 server/web 引用）→ server → web
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @aap/shared build \
 && pnpm --filter @aap/server build \
 && pnpm --filter @aap/web build
# 产出自包含的服务端部署目录（含 workspace 依赖 @aap/shared）
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @aap/server --prod deploy --legacy /out

# ---------- 运行阶段 ----------
FROM node:22-alpine
RUN sed -i 's#https://dl-cdn.alpinelinux.org#https://mirrors.cloud.tencent.com#g' /etc/apk/repositories \
 && apk add --no-cache tini python3 py3-flask \
 # 沙箱可选降权：预建非特权用户；运行时加 SANDBOX_UID=10001 SANDBOX_GID=10001 生效
 # （需保证数据卷对 10001 可写，如：docker run 时对挂载目录 chown 10001:10001）
 && addgroup -g 10001 aap && adduser -D -u 10001 -G aap aap
WORKDIR /out
# pnpm deploy 产物：package.json + node_modules（含 @aap/shared 构建产物）
COPY --from=build /out ./
# 服务端编译产物与迁移
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/server/drizzle ./drizzle
# 前端构建产物（server 生产托管 + SPA 兜底）
COPY --from=build /app/apps/web/dist ./public
# .neon-aap 运行时 SDK（M4：aap 对象 + runner）
COPY --from=build /app/packages/aap-sdk ./aap-sdk
ENV PYTHONPATH=/out/aap-sdk \
    PYTHON_BIN=python3

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

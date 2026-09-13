# AI应用门户 · ai-app-portal

自托管 **AI 应用网关 + 门户**：把散落在各端口的自部署应用（尤其 AI 应用）收敛到一个域名下——统一入口、自动 HTTPS、登录鉴权、主题品牌、会员与 token 计费。**人从门户进来，应用经平台调用大模型。**

```
用户 ──HTTPS──▶ ai-app-portal（自动证书，监听端口）
                  ├─ 门户 UI ──▶ 应用卡片墙 / 主题 / 品牌 / 备案
                  ├─ 用户中心 ──▶ 个人信息 / 财务 / 安全 / 注销
                  ├─ 应用网关 ──▶ 路径反代 ──▶ 127.0.0.1:8001 (app A)
                  │             ──▶ 127.0.0.1:8002 (app B)   [HTTP + WS/SSE]
                  ├─ LLM 网关 ──▶ OpenAI 兼容中转 ──▶ 阿里云/智谱/火山/vLLM…
                  └─ 计费 ──▶ 会员×应用可见性 + token 额度池
```

## 仓库结构

| 目录 | 说明 |
|---|---|
| `apps/server` | 服务端：Express 4 + TypeScript + Drizzle ORM（SQLite 起步） |
| `apps/web` | 前端：React 18 + Vite + TS + Ant Design 5（门户 / 用户中心 / 管理后台三合一 SPA） |
| `packages/shared` | 前后端共享类型与 API 契约 |
| `packages/aap-sdk` | Python：`aap` 运行时存根 + `aap-dev` 本地调试沙箱（M4 实装） |
| `deploy/` | Docker / FPK 分发形态 |
| `docs/` | 开发文档 |
| `ai-app-portal-docs/` | 产品需求与规范（PRD / app-develop 技能） |

## 开发

```bash
pnpm install
pnpm dev          # server: http://localhost:8080 · web: http://localhost:5173
pnpm test         # 单元/集成测试（服务端 49 个）
pnpm test:e2e     # Playwright 端到端（自动起真实服务 + mock 上游）
pnpm typecheck    # 全部类型检查
```

要求 Node ≥ 22。

## M1 当前进度（工作包）

| 工作包 | 状态 |
|---|---|
| W0 契约文档（app-develop v0.2 / internal v2.1） | ✅ |
| W1 monorepo 骨架 + 主题系统 | ✅ |
| W2 安全内核（scrypt/会话/PoW/封禁/审计/CSRF） | ✅ |
| W3 账号与注册 A2（两步注册/验证码/邀请码） | ✅ |
| W4 MFA A3（TOTP/Passkey/状态机/步升） | ✅ |
| W5 应用网关 B1/B2/B4（路径反代/WS/三态门禁/限流） | ✅ |
| W6 自动 HTTPS B3（PEM 热替换/ACME/续期） | ✅ |
| W7 门户 UI A1（卡片墙/品牌/6 主题/备案） | ✅ |
| W8 用户中心 A4（资料/会话/注销冷静期） | ✅ |
| W9 管理后台 E1/E2（向导/仪表卡/防呆） | ✅ |
| W10 分发 F1/F2（Dockerfile/compose/FPK 脚手架） | ✅（镜像构建待有 Docker Hub 网络时验证） |
| W11 集成验收（E2E 主链路 ×3） | ✅（ACME staging 与真人走查待办） |

## 发布（CI）

push 到 `main` 或打 `v*` tag 时，GitHub Actions 自动：
1. 构建多架构镜像（amd64/arm64）并发布到 **ghcr.io/neon9809/ai-app-portal**（main → `latest`，tag → 版本号）
2. 真实容器冒烟（`/api/health`）→ 打包 **FPK**（镜像引用与版本一致性校验）→ 附着到 GitHub Release

发布只走 ghcr.io（Docker Hub 不使用）。tag 版本必须与根 `package.json.version` 一致。

## 里程碑

- **M1 门户可用**：路径反代（HTTP+WS/SSE）、自动 HTTPS、本地账号+注册、MFA（TOTP+Passkey）、用户中心、管理后台、Docker/FPK 分发
- **M2 LLM 网关**：OpenAI 兼容端点、多上游路由与 failover、用户级计量
- **M3 计费闭环**：会员×应用可见性、token 充值与结算、运营面板
- **M4 生态**：.neon-aap 扩展体系（HTML / Python 沙箱）、审核上架循环

详见 `ai-app-portal-docs/ai-app-portal-PRD-v0.3.1.md`。

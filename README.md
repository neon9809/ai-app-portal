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
| `examples/hk-toast-recipe` | .neon-aap HTML 包示例（纯前端：manifest.json + index.html，可直接上传门户安装） |
| `examples/ip-analyzer` | .neon-aap Python 包示例（persistent 沙箱 + manifest.env 机密注入 + egress 白名单出站，移植自 neon9809/ip-analyzer） |
| `examples/llm-proofread` | .neon-aap Python 包示例（文语校对：规则引擎 + 逐段 LLM + 全文一致性，每用户提示词/词库落 aap.db，LLM 走统一网关按账号归因计费） |
| `deploy/` | Docker / FPK 分发形态 |
| `AGENTS.md` | AI 开发代理常驻约定（硬纪律 / 按需加载 / 交互约定） |
| `docs/DEVELOPMENT.md` | 开发者文档（架构 / 配置 / LLM 网关接入 / 通知通道 / 订阅计费） |
| `ai-app-portal-docs/` | 产品需求与规范（PRD / app-develop 技能） |

## 开发

```bash
pnpm install
pnpm dev          # server: http://localhost:8080 · web: http://localhost:5173
pnpm test          # 单元/集成测试（服务端 14 个文件 145 用例）
pnpm test:e2e     # Playwright 端到端（自动起真实服务 + mock 上游）
pnpm typecheck    # 全部类型检查
```

要求 Node ≥ 22。

## 发布（CI）

push 到 `main` 或打 `v*` tag 时，GitHub Actions 自动：
1. 构建多架构镜像（amd64/arm64）并发布到 **ghcr.io/neon9809/ai-app-portal**（main → `latest`，tag → 版本号）
2. 真实容器冒烟（`/api/health`）→ 打包 **FPK**（镜像引用与版本一致性校验）→ 附着到 GitHub Release

发布只走 ghcr.io（Docker Hub 不使用）。tag 版本必须与根 `package.json.version` 一致。

## 核心能力（当前实现）

- **应用网关**：`/app/<id>/` 路径反代（HTML 改写 / `<base>` / fetch+XHR+script 猴补丁 / 路径穿越防御 / SSE 零缓冲），**WebSocket 透传**（HTTP+HTTPS 双通道），passUser 签名身份注入（X-AAP-Identity）
- **门户托管应用**：简单 HTML 页直接粘贴接入；上传 `.neon-aap` 包自动校验 manifest 并提取字段；包上传即自动签发网关凭据（加密保管，运行时注入；未声明 `llm` 能力的包凭据仅用于出站代理，LLM 调用在网关侧按能力声明闸拒绝）；manifest `env` 声明环境变量/机密（必填/可选/格式校验/默认值），归属者或管理员在门户填值、密钥加密存储（只写不读），沙箱启动时注入进程环境变量
- **LLM 网关**：OpenAI 兼容 `/v1/chat/completions`（流式）+ `/v1/models`；多上游按优先级+权重 failover；网关凭据（SHA-256 存储/可吊销/限流），**能力声明闸**对 `/v1` 直连与沙箱代理双侧强制（manifest 未声明 `llm` 一并 403）；用户级+应用级计量（append-only 账本）、余额预检 402、预估事后校正；沙箱调用支持平台默认模型与生成上限（`LLM_DEFAULT_MODEL` / `LLM_SANDBOX_MAX_TOKENS`，0=不限）、上游连通性一键测试；**无归因调用默认拒绝**（`LLM_UNATTRIBUTED_POLICY` 可放行）
- **账号与安全**：本地账号+注册（验证码 SMTP/Resend/日志兜底、邀请码事务化防双花、Turnstile）、MFA（TOTP+Passkey，绑定新因子需步升）、OIDC 单点登录（PKCE）、登录防爆破（IP+账号双维度）+IP 封禁累犯倍增+PoW、步升认证（登录即授窗口）、审计日志、敏感配置 AES-GCM 落盘、HTTPS 启用即挂 HSTS
- **订阅与计费**：功能订阅套餐（开通即入分组、到期自动降级）、额度充值与**卡券码兑换**（manual 确认渠道，支付渠道 adapter 可扩展）、运营面板（订单确认/排行/成本毛利）
- **可见性模型**：公开 / 需登录 / 指定分组与账号 / 仅自己（用户自建应用默认私有，门户对他人隐藏）
- **统一页面元素**：所有托管/代理应用右上角自动注入「应用门户 / 个人中心 / 退出登录」（portal-chrome.js，幂等失败静默），覆盖 HTML 托管、persistent 反代直连与沙箱外壳层三条通道

## 里程碑

- **M1 门户可用** ✅：路径反代（HTTP+WS/SSE）、自动 HTTPS、本地账号+注册、MFA、用户中心、管理后台、Docker/FPK 分发
- **M2 LLM 网关** ✅：OpenAI 兼容端点（含流式）、多上游路由与 failover、网关凭据、用户级+应用级计量与预检、OIDC SSO
- **M3 计费闭环** ✅：功能订阅×分组可见性、额度充值与卡券码、结算对账+到期降级、运营面板
- **M4 生态** ◐：Python 沙箱运行时（invoked 全链路 + persistent 拉起/回收/重启 + **HTTP/WS 反代透传**）、用户上传默认私有 + 审核流（审核门禁进 canAccess，未审新版对非归属者不可见）、**包签名信任链（Ed25519，官方签名免审）**、**用户包 iframe 沙箱（PRD G1：opaque origin，禁同源 cookie 面）**、统一页面元素注入（沙箱外壳层）；**沙箱内 LLM 调用已闭环归因到调用者**（环境/请求身份 → 平台代理验签 → 网关预检扣费）。剩 aap-dev 完整版。**沙箱隔离现状**：SDK 出网的受控通道为平台 egress 代理（manifest 白名单 + **解析后 IP 私网段复核**逐跳校验），runner 内置 Python 层出站守卫（直连仅放行平台地址，`AAP_NET_GUARD=0` 关闭），容器内可设 `SANDBOX_UID/GID` 降权运行（compose 已注记推荐开启）；进程级禁网、CPU/内存限额与 ns/cgroups 硬隔离待补，第三方包须先经审核再放开可见性

详见 `ai-app-portal-docs/ai-app-portal-PRD-v0.3.1.md`；开发者文档见 `docs/DEVELOPMENT.md`。

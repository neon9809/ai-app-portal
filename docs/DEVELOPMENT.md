# 开发者文档（DEVELOPMENT）

> 面向本仓库的开发者。产品需求见 `ai-app-portal-docs/ai-app-portal-PRD-v0.3.1.md`，
> 应用（.neon-aap）开发规范见 `ai-app-portal-docs/app-develop.skill-v0.2.md`。

## 1. 架构总览

```
用户 ──HTTPS──▶ ai-app-portal（Express 4 + TS，端口 8080/8443）
                  ├─ 门户 SPA（React 18 + Vite，生产由 server 托管 / 开发走 Vite 5173 代理）
                  ├─ 应用网关 /app/<id>/  ──▶ 反代上游（Dify/Streamlit…）或 托管 HTML 应用
                  │        └─ WS upgrade / SSE 零缓冲 / passUser 身份注入（X-AAP-Identity）
                  ├─ LLM 网关 /v1/* ──▶ 多上游 failover ──▶ OpenAI 兼容上游（智谱/阿里/vLLM…）
                  ├─ 账号/订阅/计费/卡券码/运营（SQLite + Drizzle）
                  └─ 通知通道（SMTP / Resend / 日志兜底）
```

- 单进程单机语义：WS 会话、LLM 挑战、限流桶均在进程内；数据（SQLite/证书/密钥/托管应用/包）在 `DATA_DIR`（默认 `apps/server/data`，Docker 为 `/data`）。
- 前后端契约单一来源：`packages/shared`（类型 + 常量）。

## 2. 开发命令

```bash
pnpm install
pnpm dev            # server:8080（tsx watch）+ web:5173（Vite，代理 /api 与 /app）
pnpm build          # shared → server → web（生产产物 apps/web/dist）
pnpm test           # 服务端测试（vitest，8 个文件 66 用例）
pnpm test:e2e       # Playwright 端到端（自动拉起真实服务 + mock 上游）
pnpm typecheck      # 全仓类型检查
pnpm db:generate    # drizzle-kit 生成迁移（schema 变更后必跑）
```

要求 Node ≥ 22。测试相互隔离：`setupTestDb()` 建临时库跑迁移，vitest forks 池隔离模块图。

## 3. 配置体系（两层）

1. **env（`apps/server/src/config`）**：端口、路径、一次性初值（如 `ADMIN_INITIAL_PASSWORD`、`TRUST_PROXY`）。启动读一次。
2. **settings 表（`lib/settings.ts` 的 `SETTING_DEFS`）**：运行时可调策略。首启用 `initial()`（通常取 env）做种子；管理后台改值即时生效。每项有 `group`（管理面板分组）/ `secret`（只写不读，回显 `********`）/ `advanced`（高级项折叠）/ `defaultsWork`（「默认值即可跑」标注）。

密钥查看：secret 型默认不可读；`GET /api/admin/secrets/:key` 可查看（记审计），管理界面同路径有「查看」按钮——自研应用接入验签（`AAP_SIGN_SECRET`）从这里取。

主要分组：站点与品牌 / 注册与账号 / 人机验证 / 通知通道（验证码发信：SMTP 或 Resend）/ 证书与 HTTPS / 安全与限流 / 应用网关 / 计费。

管理端渲染约定（`apps/web/src/pages/Admin.tsx`）：
- 每项按元数据选控件：`choiceLabels` → 下拉（中文选项）、bool → 开关、`secret` → 密码框 + 「查看」（`GET /api/admin/secrets/:key`，记审计）、int → 数字框
- `exclusiveOf` 互斥渲染：如 `MAIL_PROVIDER=resend` 时只显示 Resend 两项、隐藏 SMTP 五项
- 展示降噪：短标签 + 悬浮详情（完整描述与配置键）；仅 `defaultsWork=false` 的项显示「需配置」橙标
- 「通知通道」「计费」「证书(HTTPS 跳转)」等有专用面板，经 `excludeKeys` 排除由专用表单写入的键

## 4. 应用网关（/app/\<id\>/）

- 应用注册在 `apps` 表（管理后台 → 应用管理），三种形态 `kind`：
  - `upstream`：反代到内网上游（HTML 改写 + `<base>` + fetch/XHR/script 猴补丁 + 路径穿越双查 + `duplex:'half'` + SSE 零缓冲）
  - `html`：门户托管静态页（`DATA_DIR/appsites/<id>/`），支持简单 HTML 粘贴接入与 .neon-aap html 包
  - `package`：python 包已上传、等待 M4 运行时（当前返回占位页，不在门户展示）
- WebSocket：HTTP 与 HTTPS server 均挂 `upgrade` → 路径匹配 → 会话鉴权 → 三态门禁 → TCP 管道。
- 限流：真令牌桶双维度（每用户 + 每 IP 兜底），`RATE_USER_PER_MIN` / `RATE_IP_PER_MIN`。
- 可见性 `visibility`：
  - `public` 全员（含匿名）
  - `login` 全部登录用户
  - `restricted` 登录 + 命中 `app_acl`（分组或账号）任一；ACL 为空 = 全部登录用户；归属者与管理员恒可见
  - `private` 仅归属者（用户自建应用默认；门户对非归属者隐藏卡片）
- passUser 身份注入：`X-AAP-Identity`（base64url JSON：uid/kind/subject/aud/jti/iat/exp）+ `X-AAP-Identity-Sig`（HMAC-SHA256，密钥 `AAP_SIGN_SECRET`）。应用侧验签参考 `gateway/identity.ts` 的 `verifyIdentity`（aud 与 (kind,uid) 契约必查）。
- 统一页面元素：HTML 响应自动注入 `/portal-chrome.js`（应用门户 / 个人中心 / 退出登录，带会话态显示与回跳）；幂等、失败静默。包作者须预留右上角空间且不得自建登录。

## 5. LLM 网关（/v1/*，M2）

接入零成本（OpenAI SDK）：

```python
from openai import OpenAI
client = OpenAI(base_url="http://<host>:8080/v1", api_key="aapk_…")
```

- **凭据（C2）**：管理后台 → LLM 网关 → 签发；SHA-256 存储、可吊销、可按凭据限流（`perMinuteLimit`，默认 `RATE_LLM_PER_MIN`=60/分）。
- **模型路由（C3/C4）**：`llm_routes` 把公开模型名映射到上游真实模型；同模型多条 = failover 候选（`priority` 升序、同级 `weight` 加权随机）；切换条件：连接失败/超时/5xx/429/408。`multiplier`（千分比收入倍率）与 `costPer1k`（千 token 上游成本，分）用于毛利统计。
- **流式（C1）**：SSE 零缓冲透传，自动注入 `stream_options.include_usage` 捕获末帧 usage；不中途掐断。
- **计量（C5）**：`llm_ledger` append-only（usage 负 delta / grant 正 / adjust 正），用户归因来自应用转发的身份头（验签 `AAP_SIGN_SECRET`，aud=appId）；无头时仅应用级计量。
- **预检（C6）**：请求前按 `max_tokens×倍率` 原子递减 `llm_balance_cache`，不足 → `402 INSUFFICIENT_BALANCE`；响应后按实际用量校正；结算循环每分钟对账（重算近期活跃用户，吸收崩溃漂移）。
- **用户归因**：应用把门户注入的身份头原样转发给网关即可。

## 6. 账号与通知通道

- 注册两步（资料 → 邮箱验证码），验证码通道 `MAIL_PROVIDER`：`smtp`（五项配置）或 `resend`（仅需 API Key，`RESEND_FROM` 留空用沙箱发件人）；都未配置时为日志兜底（验证码打到服务端日志，内网可离线）。
- 防滥用：注册/找回/绑定全程 PoW + 可选 Turnstile；同通道 60s 限 1 条 + 24h 上限；同 IP 24h 注册 ≤5。
- MFA：TOTP（±1 窗 + 计数器重放拒绝）+ Passkey（WebAuthn）+ 恢复码（10 枚一次性）+ 步升认证（密码或因子重验，`MFA_STEPUP_TTL` 内免重验）；管理员强制启用。
- OIDC SSO：配置 Issuer/ClientId/Secret 即启用（重启生效）；`OIDC_ADMIN_SUBJECTS` 首登提升管理员。

## 7. 订阅与计费（M3）

- **功能订阅**：`membership_plans`（名称/对应分组/时长/价格分/赠额度）→ 用户下单（manual 渠道，管理员运营面板确认到账）→ 自动入分组 + 赠额度到账；到期结算循环自动降级（移出分组、数据保留）。
- **额度充值**：订单按 `TOPUP_TOKENS_PER_FEN` 折算到账；`SHOW_TOPUP_PANEL` 可对用户隐藏充值面板（兑换码不受影响）。
- **卡券码**：批量生成额度码/订阅码（`AAP-XXXX-XXXX-XXXX`），原子兑换防双花，可作废/设有效期；兑换走 `grantTokens`（三触发失效缓存）。
- **运营面板**：30 天收入/成本/毛利（成本按路由 `costPer1k`）、余额与消耗排行、应用热度、订单确认；用户额度发放/调减入口与计费设置（`TOPUP_TOKENS_PER_FEN`、`SHOW_TOPUP_PANEL`）也在本页。

## 8. 分发（deploy/）

- Docker：`deploy/docker/Dockerfile`（两阶段，含 web 构建与文档资产），`docker-compose.yml`；`DATA_DIR=/data` 卷。
- FPK：`deploy/fpk/build-fpk.sh`（fpk-root 模板 + `__VERSION__` 占位替换）。上架前待确认清单见 `deploy/fpk/README.md`。
- CI：`.github/workflows/docker-publish.yml` —— push main / tag `v*`：多架构镜像 → ghcr.io（冒烟 `/api/health`）→ 自动打包 FPK 附 Release；tag 必须与根 `package.json.version` 一致。

## 9. 约束与纪律

- 迁移：schema 改动后 `pnpm db:generate`，禁手改已发布迁移。
- 单位指纹零进入：`X-Office-*`、校名/校色不进本仓库。
- 契约变更：`packages/shared` 为单一来源；`.neon-aap` 接口面变更必须升版 `app-develop.skill` 并同步 internal skill。
- 审计：账号/应用/网关/计费的关键动作全部落 `audit_logs`（保留期可配，分批清理）。

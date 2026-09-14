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
pnpm test           # 服务端测试（vitest，13 个文件 110 用例）
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
  - `package`：.neon-aap Python 包。`invoked` 经「统一执行入口」`POST /api/apps/:id/run` 拉起一次性进程运行；`persistent` 首次访问 `/app/<id>/` 时由平台拉起长驻进程并反代（HTTP 与 WebSocket 同通道，同一套门禁/限流；空闲 5 分钟回收、崩溃自动重启、并发执行上限 `SANDBOX_MAX_CONCURRENT_RUNS`）
- **用户包 iframe 沙箱（PRD G1 落地）**：归属者非管理员的 html/package 应用，入口渲染为门户外壳页 + `<iframe sandbox="allow-scripts …">`（**无 allow-same-origin**）加载 `/app/<id>/raw/…`；包内容运行在 opaque origin——读 `/api` 受 CORS 拦、写 `/api` 受 CSRF（Origin: null）拦，无同源 cookie 面；统一页面元素挂在外壳层（包代码不可触碰）；管理员自建应用保持既往直出行为
- **审核门禁（G3 落地）**：`canAccess` 对 `reviewStatus` 为 pending/rejected 的应用仅放行归属者与管理员；非私有应用推未审新版先置 `enabled=false` 下线，审核通过恢复（「已公开应用推新版即时生效」的绕过路径已封堵）
- WebSocket：HTTP 与 HTTPS server 均挂 `upgrade` → 路径匹配 → 会话鉴权 → 三态门禁 → TCP 管道；`persistent` 沙箱应用的 WS 经同一门禁透传到沙箱端口（与 HTTP 反代同路径语义；沙箱外壳 raw 通道同理剥除）。
- **安全加固（2026-09-14 批）**：网关错误页全参数 HTML 转义 + `/app/:id` isSlug 校验（防反射/存储 XSS，线上实锤项）；托管应用越界判断改 `path.relative`（防 `..%2F兄弟目录` 跨用户读文件，线上实锤项）；`display_name` 剥 HTML 敏感字符 + 限长；persistent 沙箱响应头套用 `RESP_STRIP`（防 cookie tossing / CSP 覆写）并逐请求注入签名身份头；persistent 崩溃重启计数随条目继承（`MAX_RESTARTS` 真正生效防 CrashLoop）；invoked stdout/stderr 捕获 512KB 上限 + 执行排队上限 64（超出 429 `SANDBOX_BUSY`）。
- 限流：真令牌桶双维度（每用户 + 每 IP 兜底），`RATE_USER_PER_MIN` / `RATE_IP_PER_MIN`。
- 可见性 `visibility`：
  - `public` 全员（含匿名）
  - `login` 全部登录用户
  - `restricted` 登录 + 命中 `app_acl`（分组或账号）任一；ACL 为空 = 全部登录用户；归属者与管理员恒可见
  - `private` 仅归属者（用户自建应用默认；门户对非归属者隐藏卡片）
- passUser 身份注入：`X-AAP-Identity`（base64url JSON：uid/kind/subject/aud/jti/iat/exp）+ `X-AAP-Identity-Sig`（HMAC-SHA256，密钥 `AAP_SIGN_SECRET`）。应用侧验签参考 `gateway/identity.ts` 的 `verifyIdentity`（aud 与 (kind,uid) 契约必查）。客户端自带的身份头在代理入口一律剥除（HTTP/WS/沙箱反代同一张剥离表），仅网关签名注入的可信。
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
- **计量（C5）**：`llm_ledger` append-only（usage 负 delta / grant 正 / adjust 正），用户归因来自应用转发的身份头（验签 `AAP_SIGN_SECRET`，aud=appId）；无头时仅应用级计量。计费倍率取**实际服务的候选**上游（同模型各路由 multiplier 可不同）。
- **预检（C6）**：请求前按 `max_tokens×倍率` 原子递减 `llm_balance_cache`，不足 → `402 INSUFFICIENT_BALANCE`；响应后按实际用量校正；**全候选失败/上游 4xx/流式中断等无用量路径即时全额退回预估扣减**；结算循环每分钟对账（重算近期活跃用户，吸收崩溃漂移），**对账重算补减进程内在途预估**（防预检扣减被周期性抹除）。流式转发有闲置超时（`LLM_STREAM_IDLE_TIMEOUT`，默认 60s 无新字节即断开并按已收 usage 结算），防上游挂起占满连接。
- **无归因调用默认拒绝**：`/v1/chat/completions` 未携带可验签身份头时默认 `403 ATTRIBUTION_REQUIRED`（否则任何持 app token 者可绕过全部余额闸门免费调用，线上实锤项）；可信内网应用可由管理员将计费设置 `LLM_UNATTRIBUTED_POLICY` 切为 `allow`（仅计量不计费）。
- **用户归因**：应用把门户注入的身份头原样转发给网关即可。客户端自带的 `x-aap-identity*` 请求头在网关侧一律剥除（HTTP 与 WS 同语义），只认可信注入的签名头。

## 6. 账号与通知通道

- 注册两步（资料 → 邮箱验证码），验证码通道 `MAIL_PROVIDER`：`smtp`（五项配置）或 `resend`（仅需 API Key，`RESEND_FROM` 留空用沙箱发件人）；都未配置时为日志兜底（验证码打到服务端日志，内网可离线）。
- 防滥用：注册/找回/绑定全程 PoW + 可选 Turnstile；同通道 60s 限 1 条 + 24h 上限；同 IP 24h 注册 ≤5。**找回验证码错猜 ≥5 次（10 分钟窗）作废该邮箱全部待用码**，错猜计入登录失败队列（联动 PoW 门槛与 IP 自动封禁）；重新发码即恢复全新尝试额度。
- MFA：TOTP（±1 窗 + 计数器重放拒绝）+ Passkey（WebAuthn）+ 恢复码（10 枚一次性）+ 步升认证（密码或因子重验，`MFA_STEPUP_TTL` 内免重验）；管理员强制启用。**TOTP 登录/步升验证错猜 ≥5 次（10 分钟窗）作废当前会话**（`MFA_TOO_MANY_ATTEMPTS`），防持密码会话在线穷举第二因子。**绑定新因子（TOTP enroll/confirm、Passkey 注册）需步升认证**（防被劫持会话静默绑新因子实现持久化）；登录即授予步升窗口（密码/Passkey/邮箱码本身就是刚验证过的因子，强制绑 MFA 流程因此不被卡）。
- 防爆破双维度：IP 维度之外增加**账号维度**失败计数（`login_attempts.user_key`），同账号跨 IP 分布式撞库同样触发 PoW 要求。邀请码消费在注册事务内带 `usedBy IS NULL` 条件（防并发双花）。
- OIDC SSO：配置 Issuer/ClientId/Secret 即启用（重启生效）；`OIDC_ADMIN_SUBJECTS` 首登提升管理员；待批准账号重复登录干净回到待批提示（不下发即刻失效的会话）。

## 7. 订阅与计费（M3）

- **功能订阅**：`membership_plans`（名称/对应分组/时长/价格分/赠额度）→ 用户下单（manual 渠道，管理员运营面板确认到账）→ 自动入分组 + 赠额度到账；到期结算循环自动降级（移出分组、数据保留）。**订单确认/会员开通/兑换入账均为单事务**：置 paid 与入账同生共死，入账失败整体回滚（订单回到 pending、码回到未用态），杜绝「已收款未入账」。
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
- 沙箱隔离现状：`.neon-aap` Python 进程的受控出网通道是平台 egress 代理（manifest 白名单 + IP 黑名单**逐跳**校验，`routes/aap.ts`）；runner 内置 **Python 层出站守卫**（`connect` 仅放行 `AAP_PLATFORM`，直连其余地址/Unix socket 报错，`AAP_NET_GUARD=0` 关闭）；子进程环境变量走白名单（`lib/sandbox.ts` 的 `SANDBOX_ENV_KEYS`）；invoked 执行有全局并发上限（`SANDBOX_MAX_CONCURRENT_RUNS`，默认 8，超出排队防进程炸弹）；容器内可设 `SANDBOX_UID`/`SANDBOX_GID` 让沙箱以预建的 aap 用户（10001）降权运行。**进程级禁网、CPU/内存限额与 ns/cgroups 硬隔离仍未实装**（Python 层守卫属纵深防御，非硬保证），第三方包必须先经审核流（G3）再放开可见性。
- **应用环境变量 / 机密（G6）**：包在 manifest `env` 声明变量（required/secret/pattern/default，保留名黑名单防劫持 `AAP_*`/`PORT`/代理变量等平台注入面，`parseEnvSpec`），归属者/管理员经 `GET/PUT /api/apps/:id/env` 填值（`app_env_vars` 表 AES-256-GCM 加密落盘，secret 只写不读仅回尾 4 位 hint，审计只记名不记值）；`baseEnv()` 在 invoked/persistent 沙箱启动时注入（未配置非机密变量回退声明 default）；必填缺配在执行（400 ENV_MISSING）/拉起（503 错误页）时明确拦截；persistent 配置变更后自动重启进程。入口：管理后台·应用管理与用户中心·我的应用的「环境变量」弹窗。规范见 `ai-app-portal-docs/app-develop.skill-v0.2.md` §1.1。
- 包上传安全语义：用户提交（`POST /api/apps/submit`）与执行（`/api/apps/:id/run`）均要求登录；正式目录的写入/删除一律在归属校验与同名查重之后（admin 上传 409 不触碰既有站点目录）；临时目录按请求唯一命名；15MB 包体 JSON 在鉴权之后解析（匿名大包 DoS 面收敛）。
- **egress 出站代理（P0-3 修复）**：白名单域名经 `dns.lookup` 解析后对全部 A/AAAA 复核私网/保留段黑名单（环回/RFC1918/169.254 链路本地/CGNAT/ULA 等，防 `*.nip.io` 类 DNS 绕过，线上实锤项）；IP 字面量与 localhost/.local/.internal 仍一律拒绝；出站失败详情只进服务端日志不回传调用者（防内网探测 oracle）。残留风险：解析与请求间存在理论 TOCTOU 窗口，容器形态网络隔离补齐后消除。 **内网部署例外**：管理员可在「应用网关 → 内网出站白名单」（`EGRESS_INTRANET_ALLOWLIST`）配置域名/IP/IPv4 CIDR，命中即完全放行（管理员权威高于包声明，无需包 manifest 重复声明；CIDR 区间无法逐 IP 声明）；169.254 链路本地无条件拒绝。未命中时包 manifest 照常生效、内网目标照常拒绝。**自定义请求头转发**：`aap.http.fetch(url, timeout, headers)` 支持包传自定义头（第三方 API 鉴权场景，密钥经门户环境变量注入）；≤16 个、值 ≤4KB，Host/Connection/Content-Length/Proxy-* 等逐跳与托管头剥除；响应 `{"status": 上游状态码, "body": 文本≤500KB}`。
- **敏感配置加密**：settings 的 secret 型配置（`AAP_SIGN_SECRET`/`SMTP_PASS`/`RESEND_API_KEY`/`OIDC_CLIENT_SECRET`）落盘前 AES-256-GCM 加密（`enc:` 前缀自描述；存量明文读取兼容，后台再次保存即转密文）。
- **传输与跳转**：HTTPS 实际启用时全站挂 HSTS（2 年，主域）；HTTP→HTTPS 跳转目标只认 `ACME_DOMAIN`（不反射请求 Host，防直达源 IP 场景的钓鱼/缓存投毒组件）。
- **信息泄露收敛**：匿名 `/api/health` 仅回 ok（version/uptime 移入管理员总览）；登录 401 不再回 failures/banned；`/api/dev/guide` 需登录。
- **身份头（X-AAP-Identity）**：验签强制 exp 存在且未过期；jti 一次性（TTL 窗口内防重放；平台内部归因 `allowReplay` 豁免）。`/api/admin/redeem/*` 显式挂 `requireAdmin`（不再依赖挂载顺序偶然保护）。`AAP_PLATFORM`/沙箱平台地址一律取服务端真实监听地址（`req.socket.localPort`），绝不信客户端 Host。
- 包签名信任链（G4，Ed25519）：包内可选 `signature.json`；上传时四态判定（`verified`/`untrusted`/`unsigned`/`invalid`，invalid 硬拒），状态落 `apps.signature_status`。**信任公钥命中 → 免审**（上传即 approved、submit-review 自动通过）。信任列表管理：`/api/admin/signing-keys` CRUD + 内置官方公钥（环境变量 `AAP_OFFICIAL_SIGN_PUBKEY`）。签名工具 `packages/aap-sdk/sign-aap.mjs`（keygen/sign/verify），机制详见 `packages/aap-sdk/SIGNING.md`。
- OIDC 管理面板：「安全」页展示 OIDC 配置组，并在顶部按当前访问地址自动生成**回调地址（一键复制）**——在 IdP 登记的重定向 URI 即该地址；Issuer/ClientId/Secret 修改后需重启生效。

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
pnpm test           # 服务端测试（vitest，16 个文件 176 用例）
pnpm test:e2e       # Playwright 端到端（自动拉起真实服务 + mock 上游）
pnpm typecheck      # 全仓类型检查
pnpm db:generate    # drizzle-kit 生成迁移（schema 变更后必跑）
```

要求 Node ≥ 22。测试相互隔离：`setupTestDb()` 建临时库跑迁移，vitest forks 池隔离模块图。

## 3. 配置体系（两层）

1. **env（`apps/server/src/config`）**：端口、路径、一次性初值（如 `ADMIN_INITIAL_PASSWORD`、`TRUST_PROXY`）。启动读一次。
2. **settings 表（`lib/settings.ts` 的 `SETTING_DEFS`）**：运行时可调策略。首启用 `initial()`（通常取 env）做种子；管理后台改值即时生效。每项有 `group`（管理面板分组）/ `secret`（只写不读，回显 `********`）/ `advanced`（高级项折叠）/ `defaultsWork`（「默认值即可跑」标注）。

密钥查看：secret 型默认不可读；`GET /api/admin/secrets/:key` 可查看（记审计），管理界面同路径有「查看」按钮——自研应用接入验签（`AAP_SIGN_SECRET`）从这里取。passUser 应用免手动取值：勾选「注入用户身份」的 .aap 包沙箱自动注入 `AAP_SIGN_SECRET`（baseEnv）；上游应用在管理后台应用表单勾选 passUser 时直接显示复制。后台轮换密钥（stopAllPersistent）或切换 passUser 开关（stopPersistentFor）自动停起 persistent 进程，下次访问以新配置拉起。

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
  - `package`：.neon-aap Python 包。`invoked` 经「统一执行入口」`POST /api/apps/:id/run` 拉起一次性进程运行；`persistent` 首次访问 `/app/<id>/` 时由平台拉起长驻进程并反代（HTTP 与 WebSocket 同通道，同一套门禁/限流；空闲回收 `SANDBOX_IDLE_RECYCLE_SECONDS` 默认 300s 可调、崩溃自动重启上限 3 次、并发执行上限 `SANDBOX_MAX_CONCURRENT_RUNS`、全局进程数上限 `SANDBOX_MAX_PERSISTENT`（默认 12，超限回收最久未用进程腾位））。反代转发前剥 `/app/<id>` 前缀（包路由挂根），前缀经 `x-forwarded-prefix` 下发、站内相对 `Location` 镜像回写；门户卡片直跳 `/app/<id>/`（`/open/<id>` 保留为兼容重定向页）
- **用户包 iframe 沙箱（PRD G1 落地）**：归属者非管理员的 html/package 应用，入口渲染为门户外壳页 + `<iframe sandbox="allow-scripts …">`（**无 allow-same-origin**）加载 `/app/<id>/raw/…`；包内容运行在 opaque origin——读 `/api` 受 CORS 拦、写 `/api` 受 CSRF（Origin: null）拦，无同源 cookie 面；统一页面元素挂在外壳层（包代码不可触碰）；管理员自建应用保持既往直出行为。**raw 通道响应强制覆盖 `Content-Security-Policy: sandbox allow-scripts …; object-src 'none'; base-uri 'none'`（RAW_SANDBOX_CSP，HTTP 托管与 persistent 反代两路同一份）**——顶层导航直达 raw URL 同样被关进 opaque origin，iframe 不再是唯一隔离点（2026-09-19 审计 P0）；raw 判定锚定段边界 `^raw(?:/|$)`，`rawfoo` 类路径不再误判直出。
- **审核门禁（G3 落地）**：`canAccess` 对 `reviewStatus` 为 pending/rejected 的应用仅放行归属者与管理员；非私有应用推未审新版先置 `enabled=false` 下线，审核通过恢复（「已公开应用推新版即时生效」的绕过路径已封堵）
- WebSocket：HTTP 与 HTTPS server 均挂 `upgrade` → 路径匹配 → 会话鉴权 → 三态门禁 → TCP 管道；`persistent` 沙箱应用的 WS 经同一门禁透传到沙箱端口（与 HTTP 反代同路径语义：**转发前剥 `/app/<id>` 前缀并下发 `x-forwarded-prefix`**，raw 通道剥除 raw 段——2026-09-19 审计修复前 WS 未剥前缀，persistent 应用 WS 不可用）。
- **安全加固（2026-09-14 批）**：网关错误页全参数 HTML 转义 + `/app/:id` isSlug 校验（防反射/存储 XSS，线上实锤项）；托管应用越界判断改 `path.relative`（防 `..%2F兄弟目录` 跨用户读文件，线上实锤项）；`display_name` 剥 HTML 敏感字符 + 限长；persistent 沙箱响应头套用 `RESP_STRIP`（防 cookie tossing / CSP 覆写）并逐请求注入签名身份头；persistent 崩溃重启计数随条目继承（`MAX_RESTARTS` 真正生效防 CrashLoop）；invoked stdout/stderr 捕获 512KB 上限 + 执行排队上限 64（超出 429 `SANDBOX_BUSY`）。
- 限流：真令牌桶双维度（每用户 + 每 IP 兜底），`RATE_USER_PER_MIN` / `RATE_IP_PER_MIN`；IP 维度按 `TRUST_PROXY` 解析且 HTTP 与 WS upgrade 同语义（开启取 XFF 最右一跳，未开启用 socket 地址，防伪造 XFF 绕过限流）。
- 可见性 `visibility`：
  - `public` 全员（含匿名）
  - `login` 全部登录用户
  - `restricted` 登录 + 命中 `app_acl`（分组或账号）任一；ACL 为空 = 全部登录用户；归属者与管理员恒可见；**PUT 更新应用会实际落 ACL**（未提交的一侧保留现值，变更记 `app.acl.update` 审计——2026-09-19 审计前 PUT 静默丢弃 ACL）
  - `private` 仅归属者（用户自建应用默认；门户对非归属者隐藏卡片）
- passUser 身份注入：`X-AAP-Identity`（base64url JSON：uid/kind/subject/aud/jti/iat/exp）+ `X-AAP-Identity-Sig`（HMAC-SHA256，密钥 `AAP_SIGN_SECRET`）。应用侧验签参考 `gateway/identity.ts` 的 `verifyIdentity`（aud 与 (kind,uid) 契约必查）。验签密钥自动下发：passUser 的 .aap 包沙箱 env 注入 `AAP_SIGN_SECRET`，上游应用在应用表单勾选时显示复制（详见 §3 密钥查看）。客户端自带的身份头在代理入口一律剥除（HTTP/WS/沙箱反代同一张剥离表），仅网关签名注入的可信。
- 统一页面元素：HTML 响应自动注入 `/portal-chrome.js`（应用门户 / 个人中心 / 退出登录，带会话态显示与回跳）；幂等、失败静默。覆盖三条通道：HTML 托管直出、persistent 反代直连（HTML 缓冲注入，2MB 上限）、沙箱外壳层（包代码不可触碰，raw 通道不重复注入）。包作者须预留右上角空间且不得自建登录。

## 5. LLM 网关（/v1/*，M2）

接入零成本（OpenAI SDK）：

```python
from openai import OpenAI
client = OpenAI(base_url="http://<host>:8080/v1", api_key="aapk_…")
```

- **凭据（C2）**：管理后台 → LLM 网关 → 签发；SHA-256 存储、可吊销、可按凭据限流（`perMinuteLimit`，默认 `RATE_LLM_PER_MIN`=60/分）。
- **模型路由（C3/C4）**：`llm_routes` 把公开模型名映射到上游真实模型；同模型多条 = failover 候选（`priority` 升序、同级 `weight` 加权随机）；切换条件：连接失败/超时/5xx/429/408。`multiplier`（千分比收入倍率）与 `costPer1k`（千 token 上游成本，分）用于毛利统计。
- **流式（C1）**：SSE 零缓冲透传，自动注入 `stream_options.include_usage` 捕获末帧 usage；不中途掐断。
- **超时（可配）**：`LLM_TTFB_TIMEOUT_SECONDS`（流式首字节，默认 15s，超时切候选；推理型模型首字节慢可调大）与 `LLM_TOTAL_TIMEOUT_SECONDS`（非流式整体，默认 120s）；流式闲置断开 `LLM_STREAM_IDLE_TIMEOUT`（默认 60s）。
- **计量（C5）**：`llm_ledger` append-only（usage 负 delta / grant 正 / adjust 正），用户归因来自应用转发的身份头（验签 `AAP_SIGN_SECRET`，aud=appId）；无头时仅应用级计量。计费倍率取**实际服务的候选**上游（同模型各路由 multiplier 可不同）。
- **预检（C6）**：请求前按 `max_tokens×倍率` 原子递减 `llm_balance_cache`，不足 → `402 INSUFFICIENT_BALANCE`；响应后按实际用量校正；**全候选失败/上游 4xx/流式中断等无用量路径即时全额退回预估扣减**；结算循环每分钟对账（重算近期活跃用户，吸收崩溃漂移），**对账重算补减进程内在途预估**（防预检扣减被周期性抹除）。流式转发有闲置超时（`LLM_STREAM_IDLE_TIMEOUT`，默认 60s 无新字节即断开并按已收 usage 结算），防上游挂起占满连接。**例外（2026-09-19 审计 P1-7 修复）：内容已流出但无 usage 帧（客户端断连/上游不回 include_usage）不再全额退回**——prompt 按请求体估算（字符数/4）、completion 按已转发字节数/4 估算入账；流末无换行符的 usage 残行也会补解析，真实值优先于估算。
- **无归因调用默认拒绝**：`/v1/chat/completions` 未携带可验签身份头时默认 `403 ATTRIBUTION_REQUIRED`（否则任何持 app token 者可绕过全部余额闸门免费调用，线上实锤项）；可信内网应用可由管理员将计费设置 `LLM_UNATTRIBUTED_POLICY` 切为 `allow`（仅计量不计费）。
- **用户归因**：应用把门户注入的身份头原样转发给网关即可。客户端自带的 `x-aap-identity*` 请求头在网关侧一律剥除（HTTP 与 WS 同语义），只认可信注入的签名头。
- **沙箱默认模型与生成上限**：`aap.llm.chat` 不指定 model 时按规范 §3.1 取 `LLM_DEFAULT_MODEL` 设置（计费组），未设置取模型目录排序第一个；目录为空返回可读 400。生成上限 `LLM_SANDBOX_MAX_TOKENS`（计费组）：包未显式指定 max_tokens 时注入，**0 = 不限制**（默认，模型自然收尾；推理型模型思考消耗大，包内硬编码上限会把 JSON 截半截——llm-proofread 实测）。
- **上游连通性测试**：`POST /api/admin/llm/upstreams/:id/test` 用该上游第一条启用路由的真实模型发 1-token chat ping（比 /models 列表更能暴露 key 失效、http/https 边缘拦截、模型名映射错误）；管理后台「LLM 网关 → 上游」每行有「测试」按钮。实测教训：DeepSeek 填 `http://api.deepseek.com` 会被边缘 401（Authentication Fails governor），必须 https。

## 6. 账号与通知通道

- 注册两步（资料 → 邮箱验证码），验证码通道 `MAIL_PROVIDER`：`smtp`（五项配置）或 `resend`（仅需 API Key，`RESEND_FROM` 留空用沙箱发件人）；都未配置时为日志兜底（验证码打到服务端日志，内网可离线）。
- 防滥用：注册/找回/绑定全程 PoW + 可选 Turnstile；同通道 60s 限 1 条 + 24h 上限；同 IP 24h 注册 ≤5（**计数含已完成注册**——registrations 完成时置 `completed_at` 保留行而非删行，完成行超 24h 清、未完成行按 TTL 清；2026-09-19 审计前删行即释放名额，上限形同虚设）。**找回验证码错猜 ≥5 次（10 分钟窗）作废该邮箱全部待用码**，错猜计入登录失败队列（联动 PoW 门槛与 IP 自动封禁）；重新发码即恢复全新尝试额度。**找回密码发码的 60s 重发/日上限命中时对外静默 200**（与不存在的邮箱响应体完全一致，ghost 路径补等量 scrypt 拉齐时序量级）——429 差异曾是确定性账号枚举 oracle（2026-09-19 审计修复）。
- MFA：TOTP（±1 窗 + 计数器重放拒绝，写回带 `last_used_counter < ?` 条件护栏防并发一码双用）+ Passkey（WebAuthn）+ 恢复码（10 枚一次性）+ 步升认证（密码或因子重验，`MFA_STEPUP_TTL` 内免重验）；管理员强制启用。**TOTP 登录/步升验证错猜 ≥5 次（10 分钟窗）作废当前会话**（`MFA_TOO_MANY_ATTEMPTS`），**并叠加账号维度持久计数（login_attempts 表 `mfa:<uid>` 命名空间，跨会话合计，成功清零，ip 列写哨兵不污染 IP 封禁面）**——单会话作废后重新登录不再重置额度（2026-09-19 审计修复）。**改密要求完全登录态**（`authState==='full'`，半登录态 403）。**强制流程服务端门禁（forceFlowGate）**：`mustChangePassword` 或「本地 admin 未绑 MFA」（OIDC 管理员委托 IdP 豁免）的会话除白名单端点（me/logout/change-password/mfa/*/step-up/*/portal/bootstrap）外一律 403 `FORCE_CHANGE_PASSWORD`/`FORCE_ENROLL_MFA`；登录/注册响应与 /auth/me 统一返回 `mustEnrollMfa`。**绑定新因子（TOTP enroll/confirm、Passkey 注册）需步升认证**（防被劫持会话静默绑新因子实现持久化）；登录即授予步升窗口（密码/Passkey/邮箱码本身就是刚验证过的因子，强制绑 MFA 流程因此不被卡）。
- 防爆破双维度：IP 维度之外增加**账号维度**失败计数（`login_attempts.user_key`），同账号跨 IP 分布式撞库同样触发 PoW 要求。邀请码消费在注册事务内带 `usedBy IS NULL` 条件（防并发双花）。
- OIDC SSO：配置 Issuer/ClientId/Secret 即启用（重启生效）；`OIDC_ADMIN_SUBJECTS` 首登提升管理员；待批准账号重复登录干净回到待批提示（不下发即刻失效的会话）。

## 7. 订阅与计费（M3）

- **功能订阅**：`membership_plans`（名称/对应分组/时长/价格分/赠额度）→ 用户下单（manual 渠道，管理员运营面板确认到账）→ 自动入分组 + 赠额度到账；到期结算循环自动降级（移出分组、数据保留）。**订单确认/会员开通/兑换入账均为单事务**：置 paid 与入账同生共死，入账失败整体回滚（订单回到 pending、码回到未用态），杜绝「已收款未入账」。
- **额度充值**：订单按 `TOPUP_TOKENS_PER_FEN` 折算到账；`SHOW_TOPUP_PANEL` 可对用户隐藏充值面板（兑换码不受影响）。
- **卡券码**：批量生成额度码/订阅码（`AAP-XXXX-XXXX-XXXX`），原子兑换防双花，可作废/设有效期；兑换走 `grantTokens`（三触发失效缓存）。
- **运营面板**：30 天收入/成本/毛利（成本按路由 `costPer1k`）、余额与消耗排行、应用热度、订单确认；用户额度发放/调减入口与计费设置（`TOPUP_TOKENS_PER_FEN`、`SHOW_TOPUP_PANEL`）也在本页。

## 8. 分发（deploy/）

- Docker：`deploy/docker/Dockerfile`（两阶段，含 web 构建与文档资产），`docker-compose.yml`；`DATA_DIR=/data` 卷。
- FPK（**原生形态**，2026-09 定稿）：`deploy/fpk/build-fpk.sh <版本> <x86|arm|all>`——载荷 = `deploy/native` 自包含包，`manifest`/`config`/`cmd`/`wizard`/双尺寸图标按官方 fnpack 必检清单组装；**主入口 = 本服务自主监听端口**（向导 `wizard_port` 默认 8080，绑 0.0.0.0，`checkport=false`），与 Docker 形态路径行为完全一致；桌面图标 = `type=url` 端口快捷方式（不经飞牛统一网关——跨源 iframe 会被门户自身 frame-ancestors 拦截）；业务鉴权全部走门户自有账号体系。服务端 `GATEWAY_PREFIX`/`SOCKET_PATH`/`HOST` 能力保留休眠。取舍与真机待验证清单见 `deploy/fpk/README.md`。Docker 形态不再出 FPK。
- 原生（无 Docker）：`deploy/native/build-native.sh linux/arm64|linux/amd64` —— 在 node:22-bookworm（glibc）容器内构建，产出自包含包（自带 Node 22 二进制与按目标 C 库编译的 better-sqlite3，勿与 alpine/musl 产物混用），唯一外部依赖是系统 `python3`；运行方式与安全红线（systemd 专用用户替代 `SANDBOX_UID/GID` 降权）见包内 `README-NATIVE.md`。
- CI：`.github/workflows/docker-publish.yml` —— push main / tag `v*`：多架构镜像 → ghcr.io（tag 冒烟 `/api/health`）；原生 FPK 与镜像发布解耦，按 amd64/arm64 矩阵构建自包含包 → 打包 x86/arm 双 FPK 附 Release；tag 必须与根 `package.json.version` 一致。
- 测试机快速部署：`./deploy/fast-deploy.sh`（本地构建产物 + rsync + **docker cp** 灌入容器重启，零服务器下载——轻量机带宽小，服务器上构建曾两次整机饿死）；仅依赖变更（lockfile）才需服务器 `compose build`（Dockerfile 已 manifest 先行 COPY + pnpm store BuildKit 缓存挂载，源码变更不再触发全量拉包）。

## 9. 约束与纪律

- 迁移：schema 改动后 `pnpm db:generate`，禁手改已发布迁移。
- 单位指纹零进入：`X-Office-*`、校名/校色不进本仓库。
- 契约变更：`packages/shared` 为单一来源；`.neon-aap` 接口面变更必须升版 `app-develop.skill` 并同步 internal skill。
- 审计：账号/应用/网关/计费的关键动作全部落 `audit_logs`（保留期可配，分批清理）。
- **沙箱隔离现状**：`.neon-aap` Python 进程的受控出网通道是平台 egress 代理（manifest 白名单 + IP 黑名单**逐跳**校验，`routes/aap.ts`）；runner 内置 **Python 层出站守卫**（`connect` 仅放行 `AAP_PLATFORM`，直连其余地址/Unix socket 报错，`AAP_NET_GUARD=0` 关闭）；子进程环境变量走白名单（`lib/sandbox.ts` 的 `SANDBOX_ENV_KEYS`）；invoked 执行有全局并发上限（`SANDBOX_MAX_CONCURRENT_RUNS`，默认 8，超出排队防进程炸弹）；persistent 有全局进程数上限（`SANDBOX_MAX_PERSISTENT`，默认 12，超限回收最久未用进程——任务状态应落 aap.db，重拉无损）；**persistent 空闲回收时长可配**（`SANDBOX_IDLE_RECYCLE_SECONDS`，默认 300s，最小 30s，管理端改完即时生效）；沙箱以预建的 aap 用户（10001）**默认降权运行**（compose `SANDBOX_UID`/`SANDBOX_GID` 已默认启用；存量部署升级时需一次性迁移数据卷属主 `chown -R 10001:10001 <data>/appsites`，新上传包目录由平台自动放宽权限）。**开放注册 + 允许用户上传包的部署必须保持降权**，否则任意注册用户可读全站凭据哈希与 master.key（二轮渗透实测）。配套收紧：平台库 `app.db/-wal/-shm` 由 initDb 即时收紧为 0600 并挂周期兜底（checkpoint 重建后仍保持），`master.key` 0600——沙箱 uid 对两者均不可读。**进程级禁网、CPU/内存限额与 ns/cgroups 硬隔离仍未实装**（Python 层守卫属纵深防御，非硬保证），第三方包必须先经审核流（G3）再放开可见性。
- **应用环境变量 / 机密（G6）**：包在 manifest `env` 声明变量（required/secret/pattern/default，保留名黑名单防劫持 `AAP_*`/`PORT`/代理变量等平台注入面，`parseEnvSpec`），归属者/管理员经 `GET/PUT /api/apps/:id/env` 填值（`app_env_vars` 表 AES-256-GCM 加密落盘，secret 只写不读仅回尾 4 位 hint，审计只记名不记值）。除机密外，env 亦是**应用级默认配置**的承载（如 llm-proofread 的 `PROOFREAD_PROMPT`/`COHERENCE_PROMPT`：归属者配置对所有用户生效，用户个人设置可覆盖）；`baseEnv()` 在 invoked/persistent 沙箱启动时注入（未配置非机密变量回退声明 default）；必填缺配在执行（400 ENV_MISSING）/拉起（503 错误页）时明确拦截；persistent 配置变更后自动重启进程。入口：管理后台·应用管理与用户中心·我的应用的「环境变量」弹窗。规范见 `ai-app-portal-docs/app-develop.skill-v0.2.md` §1.1。
- 包上传安全语义：用户提交（`POST /api/apps/submit`）与执行（`/api/apps/:id/run`）均要求登录；正式目录的写入/删除一律在归属校验与同名查重之后（admin 上传 409 不触碰既有站点目录）；临时目录按请求唯一命名；15MB 包体 JSON 在鉴权之后解析（匿名大包 DoS 面收敛）。
- **python 包第三方依赖（skill v0.2.6 声明制）**：manifest `requirements` 声明（`parseRequirements` 仅收「名称[extras]+版本约束」，拒 URL/本地路径/-r，上限 32 条），**上传/更新时服务端 `pip install --only-binary=:all: --target <appsites>/<id>/.deps`**（`lib/pydeps.ts`，超时 300s；失败=上传被拒并清理正式目录，不带病上线）；沙箱 `baseEnv` 注入 `PYTHONPATH=.deps`（native/FPK `start.sh` 自检补装的预置框架目录经 `AAP_PREINSTALLED_PYTHONPATH` 前置——docker 镜像预装 py3-flask 无此环节）。安装源走「应用网关 → pip 索引源」设置（`PIP_INDEX_URL`，默认官方 PyPI）；新版本不再声明的依赖更新时自动清除；`.deps` 在数据卷应用目录下，容器重建/升级不丢。审核预览页照单展示依赖清单。
- **egress 出站代理（P0-3 修复）**：白名单域名经 `dns.lookup` 解析后对全部 A/AAAA 复核私网/保留段黑名单（环回/RFC1918/169.254 链路本地/CGNAT/ULA 等，防 `*.nip.io` 类 DNS 绕过，线上实锤项）；IP 字面量与 localhost/.local/.internal 仍一律拒绝；出站失败详情只进服务端日志不回传调用者（防内网探测 oracle）。残留风险：解析与请求间存在理论 TOCTOU 窗口，容器形态网络隔离补齐后消除。 **内网部署例外**：管理员可在「应用网关 → 内网出站白名单」（`EGRESS_INTRANET_ALLOWLIST`）配置域名/IP/IPv4 CIDR，命中即完全放行（管理员权威高于包声明，无需包 manifest 重复声明；CIDR 区间无法逐 IP 声明）；169.254 链路本地无条件拒绝。未命中时包 manifest 照常生效、内网目标照常拒绝。**自定义请求头转发**：`aap.http.fetch(url, timeout, headers)` 支持包传自定义头（第三方 API 鉴权场景，密钥经门户环境变量注入）；≤16 个、值 ≤4KB，Host/Connection/Content-Length/Proxy-* 等逐跳与托管头剥除；响应 `{"status": 上游状态码, "body": 文本≤500KB}`。
- **敏感配置加密**：settings 的 secret 型配置（`AAP_SIGN_SECRET`/`SMTP_PASS`/`RESEND_API_KEY`/`OIDC_CLIENT_SECRET`）落盘前 AES-256-GCM 加密（`enc:` 前缀自描述；存量明文读取兼容，后台再次保存即转密文）。
- **传输与跳转**：HTTPS 实际启用时全站挂 HSTS（2 年，主域）；HTTP→HTTPS 跳转目标只认 `ACME_DOMAIN`（不反射请求 Host，防直达源 IP 场景的钓鱼/缓存投毒组件）；**loopback Host（127.0.0.1/localhost/::1）豁免跳转**——沙箱 runner 与 FPK 统一网关的平台内部 POST 调用若被 302 到公网域名，跟随重定向会降级为 GET 打断全部沙箱出站（llm-proofread 实测）。
- **信息泄露收敛**：匿名 `/api/health` 仅回 ok（version/uptime 移入管理员总览）；登录 401 不再回 failures/banned；`/api/dev/guide` 需登录。
- **身份头（X-AAP-Identity）**：验签强制 exp 存在且未过期；jti 一次性（TTL 窗口内防重放；平台内部归因 `allowReplay` 豁免）。`/api/admin/redeem/*` 显式挂 `requireAdmin`（不再依赖挂载顺序偶然保护）。`AAP_PLATFORM`/沙箱平台地址一律取明文 HTTP 环回口（`loopbackPlatformPort`：HTTP 到达取 `req.socket.localPort`，**TLS 口到达回落 `config.port`**——第二轮渗透 NEW-2，8443 是 TLS 监听、明文调用必断），绝不信客户端 Host。
- 包签名信任链（G4，Ed25519）：包内可选 `signature.json`；上传时四态判定（`verified`/`untrusted`/`unsigned`/`invalid`，invalid 硬拒），状态落 `apps.signature_status`。**信任公钥命中 → 免审**（上传即 approved、submit-review 自动通过）。信任列表管理：`/api/admin/signing-keys` CRUD + 内置官方公钥（环境变量 `AAP_OFFICIAL_SIGN_PUBKEY`）。签名工具 `packages/aap-sdk/sign-aap.mjs`（keygen/sign/verify），机制详见 `packages/aap-sdk/SIGNING.md`。
- OIDC 管理面板：「安全」页展示 OIDC 配置组，并在顶部按当前访问地址自动生成**回调地址（一键复制）**——在 IdP 登记的重定向 URI 即该地址；Issuer/ClientId/Secret 修改后需重启生效。

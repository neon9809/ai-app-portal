---
name: app-develop
description: "开发 ai-app-portal（AI应用门户）时用：架构决策与路径反代经验。"
version: 2.1.0
---

# ai-app-portal（AI应用门户）开发指南

> v2.1.0 变更：新增 §九「沙箱日志收口与调试沙箱」（平台侧约定），与 app-develop 规范 v0.2（§3.5 日志 / §3.6 统一元素 / §八 aap-dev）配套。

Neon 的 OSS 项目：自托管 AI 应用网关 + 门户，中文名「AI应用门户」，仓库名 `ai-app-portal`。
- **PRD**：`workspace/ai-app-portal-PRD.md`（v0.3+，功能按 A–G 功能域组织：A 门户与身份 / B 应用网关 / C LLM 网关 / D 计费 / E 管理后台 / F 分发与运行 / G 生态；里程碑 M1–M4 只在第 7 节，与功能域编号解耦）
- **参考实现** = 他的私有项目 office-tool（Node/Express，CUGB 办公门户）。**私有代码可借鉴思路与代码，但任何单位指纹（校名/校色/校徽/内置业务工具）不得进入 OSS 版。**

## 一、硬决策（ADR，勿再反复讨论）

| # | 决策 |
|---|---|
| 1 | **仅路径模式路由，子域名路由不做**（硬决策） |
| 2 | **WebSocket 透传在 P0**（AI 聊天应用依赖；`upgrade` 事件 → 路径匹配 → 鉴权 → TCP 双向管道） |
| 3 | **语言 Node.js/TypeScript**（复用参考实现已验证逻辑；ACME 用 acme-client） |
| 4 | **单组织**，不做多租户/白标 |
| 5 | **计费双线**：会员订阅（×应用可见性）+ token 充值（LLM 用量，池式扣减）；不做任意 SQL 级按量账单 |
| 6 | **品牌全数据化**：logo/站名/主题/页脚/ICP+公安备案号组件；内置 ≥6 套主题（复用 fnos-dashboard 主题方法论） |
| 7 | **分发两手抓**：飞牛 FPK（初始流量主阵地，`install_dep_apps=database` 用飞牛内置 DB）+ Docker（外部/容器 DB 走 DATABASE_URL）；**两形态路径行为完全一致**——业务流量都走监听端口（service_port），差异只在基础设施装配层（配置驱动 adapter） |
| 8 | **飞牛统一网关只做桌面图标入口**：点图标 → 网关校验 NAS 登录态 → 识别 NAS 管理员 → 直接建立管理员会话（首次强制设密码）。业务调用不走统一网关 |
| 9 | **公用设施集中配置**：数据库（平台 DAL 统一访问，应用不直连）/ LLM 网关 / 反向代理，应用零配置受益 |
| 10 | **管理面板体验是 P0 验收硬指标**（详见下文 E 要求） |
| 11 | **首次初始化**：FPK = NAS 管理员免密进入 → 强制设密；Docker = 首启初始密码打印容器日志（+ data/ 一次性凭据文件）→ 登录强制改密。两形态收敛到同一份 checklist；admin 强制 MFA 不可关 |

## 二、路径模式反代的坑与解法（核心经验，office-tool 实战验证）

路径模式（`/app/<id>/` 代理上游）比子域名难：上游应用假设自己在根路径。已验证解法组合：

1. **HTML 改写**：`href/src/poster/action/srcset` 的根绝对路径 `/xxx` → `/app/<id>/xxx`；`srcset` 逐段处理。
2. **`<base>` 注入**：修正相对链接基准；base 指向上游真实挂载点（query 凭据型上游 → 根；path 凭据型上游 → 凭据路径）。
3. **运行时猴补丁（关键）**：注入脚本猴补 `XMLHttpRequest.open` / `window.fetch` / `script.src` setter，把同源根绝对路径请求改写到代理前缀——SPA 的后端 API、Next.js chunk 才能继续走代理；`history.replaceState` 剥掉前缀让前端路由正常匹配。
4. **响应头改写**：`Link` 预加载头绝对路径也要改写；`Location` 仅同源重定向改写。
5. **路径穿越防御**：逐段拒绝 `.`/`..`（含 URL 编码变体）——URL 构造器归一化会吃掉 `..` 导致逃出 base path。
6. **保留上游 base path 与 query**：只取 origin 会打挂子路径部署的上游、丢 url 凭据。
7. **SSE/流式**：禁缓冲，`Readable.fromWeb(upstream.body).pipe(res)`；客户端断开销毁上游流；带体请求走 undici 必须显式 `duplex: 'half'`（否则 POST/PUT 全 502 而 GET 正常——经典坑）。
8. **凭据注入**：上游凭据存服务端注册表（urlSecret），转发时才拼入，绝不写配置下发浏览器；支持 path 型凭据（Dify `/chat/<id>`，路径即凭据）。
9. **限流**：双维度令牌桶——每登录用户为主（NAT 场景同事不互相挤爆）+ 每 IP 兜底。
10. **明示限制**：不做 JS/HTML 深度改写；依赖 Cookie 会话的上游不工作（set-cookie 剥离）。

## 三、身份传递（passUser）

代理转发时注入：`X-AAP-Identity: base64url(JSON payload)` + `X-AAP-Identity-Sig: hex(HMAC-SHA256(secret, payload))`。
签名密钥 = 平台设置 `AAP_SIGN_SECRET`（管理后台 → 安全 → 高级项可查看/轮换；首启自动随机生成，或用环境变量 AAP_SIGN_SECRET 设初值）。

- payload 必含：`aud`（目标工具 id，防身份头转发到其他上游重放）、`jti`（一次性随机串）、`iat/exp`（10 分钟 TTL）、`kind`+`uid`（**本地账号与 OIDC 分表自增，仅按 uid 隔离会同号串号——必须 (kind, uid) 联合或用 subject**）
- 消费端校验：签名（timingSafeEqual）、exp、aud 与自身 id 一致
- passUser 同时是 **LLM 网关用户级计量的归因通道**（身份头随请求链进网关，用户级 token 归因零成本）

## 四、LLM 网关 + 计费（C/D 域核心设计）

**定位**：平台自带 OpenAI 兼容中转网关，应用调大模型一律走网关不直连云厂商；对调用形态（Agent/单次任务）无感。（早期「对外提供 MCP/manifest」的理解已被 Neon 否掉。）

- 接入零成本：OpenAI SDK 改 `base_url` + `api_key`（网关 app-token）即可
- 凭据分层：真实上游 key 只存网关侧，管理员统一维护/轮换；应用凭据可吊销可限额
- 模型目录：聚合多上游出统一 `/v1/models`；应用 `model` 字段选模型，网关按模型路由
- 路由：同模型多上游 failover（超时/5xx/限流切换）+ 健康检查 + 轮询/加权；SSE 零缓冲
- **C/D 边界：账本只有一份**——C 的用量流水（append-only，只记不判）；**余额只有一处**——D 读流水结算。C 在请求路径上（记录者+预检者），D 在请求路径外（结算者）
- **额度拦截两道闸**：① C 预检缓存（按模型倍率原子递减预估成本，无余额直接 402，请求不出网关）；② D 结算引擎异步消费流水校正余额，打穿 → 欠费态 + **主动失效 C 缓存**。漏账上限 = 并发在途请求预估成本（可控，非账目错误）
- **缓存同步三触发**：扣款（欠费）、充值到账、管理员手动调额，都必须失效 C 预检缓存（否则「充了值还被拒」灵异事件）；单机用进程内事件总线
- **流式计量**：SSE token 数结束时才确定；预检按 max_tokens/历史均值估，**不在流中途掐断**，让流完 + 事后校正 + 欠费态兜底
- 计费闭环：充值进 token 额度池 → 按模型单价扣减（不同模型不同倍率，管理员定价）→ 余额不足拒付；会员订阅与 token 池两条独立计费线可叠加；运营面板看余额排行/应用热度/上游成本 vs 毛利

## 五、安全栈（P0 直接移植 office-tool）

PoW 登录 proof-of-work、登录失败计数、IP 封禁（累犯时长倍增）、CSRF Origin 校验、scrypt 口令哈希、审计日志、`TRUST_PROXY` 语义（无前置代理置 0，防伪造 XFF 绕过封禁）。

**MFA 要点**：TOTP（RFC 6238；±1 窗口、重放拒绝、恢复码 10 枚 scrypt 哈希存储用一枚废一枚）+ Passkey（`@simplewebauthn`；二次因子与无密码主登录双角色；signCount 回退=克隆检测）；登录状态机 `password_ok → mfa_pending（低权，限绑定/恢复页）→ 完全会话`；敏感操作步升认证（重验一次因子，5 分钟 TTL 复用）；策略：admin 强制不可关、会员默认强制、普通可选；OIDC 账号 MFA 委托 IdP。

**注册要点**：注册/找回密码/绑定邮箱三入口全挂 PoW + 可选 Turnstile（后台填 key 即启用，默认 PoW 兜底，内网可离线）；验证码通道抽象（SMTP / 阿里云或腾讯云 SMS 选一首发）；验证码 6 位 5 分钟有效、同通道 60s 限 1 条 + 24h 上限（**短信轰炸 = 刷穿短信费，限发硬要求**）、哈希存储单次有效；注册开关三档默认关闭；同 IP 24h ≤ 5 号；首账号自动 admin；全事件审计。

## 六、生态：.neon-aap 用户扩展体系（G 域）

用户上传 **`.neon-aap`**（ai-app-portal 缩写命名）（ZIP：manifest.json + 静态 HTML 或 Python `mod.py`），遵循本技能出入参规范。**可见性三态：私有（自用）/ 审核中 / 公开（管理员审核后全员可用）**；管理员面板内看码/试运行/通过或驳回。

- manifest 能力声明：`capabilities`（llm/db/storage）+ `network`（**出站域名白名单**）+ `runtime`（**invoked 按调用 | persistent 持久服务**）。审核页照单审批；改白名单 = 重新审核
- HTML 包：iframe sandbox + CSP，禁同源 cookie；门户 shell 嵌入
- Python 包：**沙箱子进程**（CPU/内存受限；进程自身无网络）。invoked = 每请求新进程跑完即毁；persistent = 长驻进程声明路由前缀提供网页/HTTP API，**被 B 域反代纳管**（限流/审计/健康检查/崩溃重启/空闲回收照常），常驻内存上限更严
- **网络出口 = 平台出站代理**：逐请求核对 manifest 域名白名单放行——**白名单执行点在代理不在沙箱**（防 DNS rebinding/直连 IP 绕过）
- **SDK 存根三件套**：`llm.chat()`（走 LLM 网关，计入调用者 token 池）；`db.*`（**每包独立 SQLite，支持包内完整 SQL**——execute/query + ? 占位参数；平台业务表与其他包物理隔离不可访问，容量限额）；`storage.*`（每包独立配额空间）
- 生命周期：上传→校验→私有可用；公开须审核；版本更新=重新审核；ed25519 签名预留（官方包免审）；举报/下架/全事件审计
- 第一版刻意收窄：不做任意 pip 依赖、跨包调用、任意 SQL。先跑通「造工具→自用→审核上架」循环

## 七、管理面板体验（P0 验收硬指标）

office-tool 后台丑且交互差是已知痛点；新面板七条要求：① 视觉与门户同源（共用主题 CSS variables）；② 首次配置 checklist 向导（域名证书→管理员密码→注册策略→接第一个应用）；③ 配置项一句话说明 +「默认值即可跑」标注 + 高级项折叠；④ 危险操作防呆（告知后果+输入确认）；⑤ 状态仪表卡（证书/上游健康/代理连通 绿黄红）；⑥ 移动端可看状态做紧急操作；⑦ 保存即生效 + 测试按钮直接给结果。
**验收**：找 1–2 个没用过 office-tool 的真实用户，无文档走通「装好→配好→发布」，卡壳处整改。

## 八、FPK 要点（文档镜像：github.com/ckcoding/fnnas-docs，每晚同步官方）

统一网关（gatewayPrefix `/app/{appname}` + gatewaySocket Unix socket，NAS 登录态校验后转发附用户 Header，支持 WS）；依赖声明 `install_dep_apps`（database/cache/redis/minio，右到左安装）；运行时包 python312/nodejs_v22/java-21（`/var/apps/<rt>/target/bin` 加 PATH）；TRIM_* 环境变量族（TRIM_APPDEST/TRIM_PKGVAR 等）；Docker 类 FPK = `app/docker/docker-compose.yaml` 模板。

## 九、沙箱日志收口与调试沙箱（平台侧约定，v2.1 新增；与 app-develop 规范 v0.2 §3.5/§3.6/§八 配套）

### 9.1 日志管线（G2/G5 配套，开发日志与运行日志统一收口 portal）

- **沙箱进程唯一日志出口 = stderr 上的结构化 JSON lines**（`{ts, level, pkg, run_id, msg, ...}`）。SDK 注入的 logging handler 负责：级别格式化、**脱敏过滤**（key/token 打码）、**条数/字节限额**（超限截断并在记录里标 `truncated: true`）。
- **supervisor（沙箱父进程）捕获 stderr → 汇入平台运行记录表**（谁/哪个包/运行 ID/耗时/LLM token/日志）。invoked 与 persistent 同一条管线；persistent 的运行粒度 = 每次请求上下文。
- **级别保留策略**：`DEBUG` 仅本地调试与试运行保留；线上保留 `INFO+`，按保留期定时清理（复用 audit.js 的分批清理模式）。
- 个人端「工具运行记录」页、管理端审核页试运行日志、生态日志查询，**都读这一份记录**，不另设日志通道。
- **禁止 `print()`** 的原因要写进规范（已写）：stdout 在 invoked 模式是结构化出参协议载体。

### 9.2 调试沙箱一致性铁律

- `packages/aap-sdk` 与平台沙箱运行时**共享同一实现代码路径**（同一镜像、同一执行器；invoked/persistent 双模式同路径）。**本地调试 = 同一执行器 + `AAP_DEBUG=1` 开详细日志 + 本地资源映射**（SQLite 文件 / 目录存储 / mock LLM）。
- **禁止另写并行模拟器**——行为漂移比没有调试工具更糟。mock 实现与生产实现必须对照**同一测试集**验证行为一致（白名单拒绝、未声明能力报错、超时、JSON 校验、进程即毁）。
- 调试模式下全量详细日志：每次 `aap.*` 调用（入参脱敏后/出参摘要/耗时）、SQL 与参数、storage 操作与配额水位、HTTP 代理逐请求（URL/**白名单判定**/状态/耗时）、LLM usage、进程生命周期（启动/超时/退出码）。
- `aap-dev` CLI：`run`（invoked 一次）/ `serve`（persistent 本地起）/ `--reset` / `--llm mock|real` / `--submit`（调试日志可选回传 portal 运行记录）。
- **与线上一致的边界刻意保留**：白名单在本地照常强制、未声明能力照常报错、超时/JSON 校验/进程即毁语义相同。

### 9.3 统一 chrome 注入（「返回个人中心 / 退出登录」）

- **persistent 应用**：平台对其 HTML 响应**自动注入**统一悬浮按钮（复用 B1 反代 HTML 注入机制；注入失败静默、不阻断业务）。约定注入点为响应末尾 `</body>` 前的 `<script src="/portal-chrome.js">` + 浮层容器，按钮指向门户 `/account` 与登出端点（登出后回跳当前应用）。
- **HTML 工具**：嵌在门户 shell iframe 内，顶部 chrome 由门户天然提供，无需注入。
- 包作者侧约定（不得遮挡/右上留白/禁止自建登出）在 app-develop 规范 §3.6，审核抽查项。
- 注入实现放 B 域反代的 HTML 改写管线（G2 persistent 路由纳管后同样生效），**不要**在沙箱 SDK 里做注入（保持 SDK 纯粹、失败语义一致）。

### 9.4 `aap` 接口冻结

- `aap` 对象接口面（`llm` / `db` / `storage` / `http` / `log`）以 app-develop 规范 §三 为准，**开发期即冻结**；新增能力必须走规范升版 + manifest 能力字段同步 + 审核页展示同步，不允许运行时动态扩面。
- 实装顺序：W0（本节）定契约 → M4 实装 `packages/aap-sdk`；接口冻结后 M2/M3 的 LLM 网关计量、配额预检对 SDK 透明（SDK 只见 `aap.llm.chat` 语义）。

---
name: neon-aap-develop
description: "当用户要求开发、打包或重构 .neon-aap 应用（AI应用门户扩展包）时使用：manifest 契约、aap.* 能力接口、沙箱纪律与交付自检。"
---

# app-develop.skill.md

> AI应用门户（ai-app-portal）应用开发规范 · 供开发 Agent 使用
> 版本 v0.2.7（2026-11）· 配套平台 v0.1.4（PRD v0.3+）
>
> **v0.2.7 变更（对齐实现现状，不改变接口面）**：① §1.2 依赖安装收窄为「仅管理员上传通道自动安装」，用户自主上传通道不安装——面向普通用户交付的包**只依赖标准库 + 预置 flask**；② `capabilities` 运行时强制范围收窄：仅 `llm` 有网关侧硬闸（未声明 403），`db`/`storage` 注入不校验声明（仍须如实声明，审批照单）；③ §3.1 删除失实的 `stream=True` 说法，改为真实接口 `chat_stream()`（整段返回后切片的伪流式），补 `identity` 参数；④ §3.5 日志收口收窄：仅 invoked 收集（ stderr 末尾约 8KB 入运行记录），**persistent 进程日志当前不收集**；无 truncated 标记、无条数配额；DEBUG 仅本地 aap-dev 可见；⑤ §七 aap-dev 如实重写：无 mock LLM，`llm`/`http` 本地无法调用（无平台凭据），本地不强制白名单/能力闸；⑥ `route` 字段标注为「当前被忽略」；⑦ 补「已公开应用推未审新版会临时下线」「invoked 执行需登录」等上传/审核实际行为；⑧ 前端纪律补 `<base>` 禁用（raw 通道 CSP `base-uri 'none'`）、HTML 工具同样需右上角留白。
>
> 历史变更：v0.2.6 requirements 声明制（admin 通道安装）；v0.2.5 passUser 密钥自动下发；v0.2.4 frontmatter + 清单合并；v0.2.3 前端纪律 + 状态纪律；v0.2.2 manifest.env；v0.2 日志/chrome/aap-dev。

---

## 你是谁、要做什么

你正在为 **AI应用门户** 开发一个新应用。用户会告诉你需求设想；你的产出是一个符合本规范的 **`.neon-aap` 包**（ZIP 文件），用户拿到后上传门户即可安装使用。

`.neon-aap` = **ai-app-portal** 的缩写。包内只有两种形态，按需求二选一：

| 形态 | 适合 | 包内容 |
|---|---|---|
| **HTML 工具** | 纯前端：格式转换、计算器、文本处理（可自带 JS） | `manifest.json` + `index.html`（可带静态资源/多文件） |
| **Python 应用** | 需要 LLM / 数据库 / 存储 / 对外提供网页或 API | `manifest.json` + `mod.py`（可带静态资源目录，由包自身服务提供） |

---

## 一、manifest.json（必读，能力全靠它声明）

```jsonc
{
  "name": "stock-summary",          // 包标识：^[a-z0-9][a-z0-9-]{0,63}$，全局唯一，同时是挂载路径 /app/<name>/
  "display_name": "股票摘要助手",     // 门户卡片名（≤64 字符，HTML 敏感字符会被平台剥除）
  "version": "1.0.0",
  "type": "python",                  // "html" | "python"
  "entry": "mod.py",                 // python 必填；html 缺省 index.html；仅限包内相对路径（含 ../ 或绝对路径上传即拒）
  "description": "输入股票代码，生成中文投资摘要",
  "author": "someone",
  "runtime": "invoked",              // "invoked" 按调用 | "persistent" 持久服务（仅 python）
  "capabilities": ["llm", "db"],     // 按需声明：llm / db / storage，不用的不要写
  "network": [                       // 出站域名白名单（无需联网则留空数组/省略）
    "api.example-data.com"
  ],
  "env": {                           // 环境变量/机密声明（§1.1；无需配置则省略）
    "ABUSEIPDB_API_KEY": { "required": true, "secret": true, "pattern": "^[a-f0-9]{80}$", "description": "AbuseIPDB 密钥" },
    "MAX_CONCURRENCY": { "required": false, "default": "4", "description": "并发上限" }
  },
  "requirements": ["flask>=3.0"]     // pip 依赖声明（§1.2；⚠ 仅管理员上传通道会安装，见说明）
}
```

**字段备注**：
- `route` 字段**当前被平台忽略**（解析但不消费）——挂载路径恒为 `/app/<manifest.name>/`，无需填写。
- `version` 为自由字符串，仅展示用；版本更新语义见 §六。
- `capabilities` 出现未知值（非 llm/db/storage）→ 上传直接失败。

**铁律**：
1. `capabilities` / `network` / `requirements` 是**审批依据**——写了什么，管理员就按什么审；上线后想改 = 重新提审。
2. 能力声明的**运行时强制范围**：`llm` 有网关侧硬闸——manifest 未声明 `llm` 的包调用 LLM（`aap.llm.chat` 或拿凭据直连 `/v1`）一律 403；`db`/`storage` 目前注入时不校验声明，但**如实声明是审核硬要求**，谎报/漏报直接驳回。宁少勿多，按需申请。
3. `runtime: "persistent"` 会常驻占用资源，审查更严：没有持续服务需求的（哪怕要调 LLM）一律用 `invoked`。

### 1.1 env——环境变量 / 机密声明

需要外部配置（第三方 API key、模型名、阈值……）时，**在 manifest `env` 里声明，不要写死在代码里，更不要自己要求用户把 key 交给你**：

```jsonc
"env": {
  "变量名": "描述",                                    // 速记：= required 必填
  "变量名": { "required": true, "secret": true, "pattern": "^…$", "default": "…", "description": "…" }
}
```

| 字段 | 说明 |
|---|---|
| `required` | 默认 `true`。必填变量未配置时：invoked 执行返回 400 `ENV_MISSING`（列出缺哪些）；persistent 拉起前返回 503 错误页 |
| `secret` | 默认 `false`。`true` = 机密：AES-256-GCM 加密落盘，门户界面只写不读（仅回显尾 4 位提示）；`false` 的已配置值归属者可读回 |
| `pattern` | 可选，保存配置时执行 `test` 的正则（不锚定，自行写 `^` `$`；≤200 字符） |
| `default` | 可选，未配置时注入的默认值（**机密变量不允许 default**；值须为字符串，≤4096 字符） |
| `description` | 展示在配置界面（≤200 字符） |

**行为与纪律**：
- 变量名须匹配 `^[A-Za-z_][A-Za-z0-9_]{0,63}$`；单包最多 **16 个**；保存值 ≤ **8192 字符**。
- **保留名不可声明**（声明即上传失败）：`AAP_*` 前缀全部，以及 `PORT`、`PATH`、`HOME`、`TMPDIR`、`LANG`、`LC_ALL`、`PYTHON*`、`SSL_CERT_*`、`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`（大小写两种）、`SANDBOX_*`、`NODE_OPTIONS`。
- 值由**归属者/管理员**在门户「环境变量」里填（用户中心·我的应用 / 管理后台·应用管理都有入口）；沙箱每次启动时注入为进程环境变量，代码里 `os.environ["变量名"]` 直接读；未配置的非机密变量回退 `default`。
- persistent 应用修改配置后平台自动杀掉进程，下次访问以新环境重新拉起（即改即生效）；invoked 天然每次生效。
- **不要把环境变量值打进 `aap.log`**（日志纪律，§3.5）。

**平台已注入、你可以直接读的环境变量**（不要再声明）：

| 变量 | 含义 |
|---|---|
| `AAP_APP_ID` | 本包 id（passUser 验签时校验 `aud` 用它） |
| `AAP_DB_PATH` / `AAP_STORAGE_DIR` / `AAP_PACKAGE_DIR` | 每包独立库/存储/包目录路径（`aap.db`/`aap.storage` 已接好，一般不用直接碰） |
| `PORT` | persistent：平台分配的监听端口 |
| `AAP_SIGN_SECRET` | passUser 应用专用：身份头 HMAC 验签密钥（§二） |

### 1.2 requirements——pip 依赖声明

代码需要的第三方库（超出标准库 + 预置框架的部分）在 manifest `requirements` 里**声明**；**不允许任何形式的运行时自装**：

```jsonc
"requirements": ["flask>=3.0", "requests==2.32.3", "beautifulsoup4"]
```

- **安装现状（重要，决定你怎么写代码）**：
  - 平台**预置**：flask（docker 镜像预装；native/FPK 形态启动自检补装）。标准库全量可用。
  - 声明制依赖的**自动安装目前仅发生在管理员上传通道**（`pip install --only-binary=:all: --target <应用目录>/.deps`，失败=上传被拒）。
  - **用户自主上传通道（`/api/apps/submit`）当前不执行安装**：声明的第三方库不会有 `.deps`，运行时 `ModuleNotFoundError`。
  - ⇒ **面向普通用户「自己上传就能用」的包，只依赖标准库 + flask**；确实需要第三方库时，在交付说明中写明「需管理员经后台上传安装依赖」，并同步在 `requirements` 里声明。
- **写法**：仅支持 `名称[extras] + 版本约束`（`==`/`!=`/`<=`/`>=`/`~=`/`<`/`>`/`===`，逗号分隔多约束）；URL / 本地路径 / `-r` 一律上传即拒；单包最多 **32 条**，重复条目去重。
- **只装 wheel**（`--only-binary=:all:`）：无预编译 wheel 的源码包装不了，上传时明确报错——换纯 Python 等价库。
- 管理员通道的版本更新会按新声明重装：不再声明的旧依赖自动清除；安装源可在平台「pip 索引源」设置（国内镜像）。

---

## 二、运行时模型（python）

### invoked（按调用）——默认选择

每次用户发起调用，平台**起一个全新进程**执行你的 `mod.py`，拿到返回后进程即销毁。

```
用户打开工具页 → 填参提交 → 平台起进程 → stdin 传入参 → 执行 handle() → stdout 取 JSON → 进程销毁
```

- **无状态**：不要依赖进程内存保存任何东西（需要就写 db/storage——但下次调用是全新进程，由下次的 handle 自己读）。
- **硬超时 30 秒**（平台固定，超时强杀、按 timeout 结算）；勿做长任务。
- **执行需登录**：`POST /api/apps/:id/run` 要求登录会话（公开应用也一样，匿名只能看卡片）。
- 并发受全局闸约束（默认 8 并发、排队 64），满载时返回 429 `SANDBOX_BUSY`，前端可提示稍后重试。
- 出入参协议：入参 = 页面提交的 JSON（键为你约定的字段名，平台**不做 schema 校验**，自行防御缺字段/类型错）；返回值须可 JSON 序列化（不可序列化的对象会被 `str()` 兜底，别依赖它）。
- 工具页的表单：`inputSchema` 字段目前**没有门户配置入口**（需管理员直接落库），默认渲染为 JSON 输入框——交付说明里给用户一段入参 JSON 示例。

### persistent（持久服务）——仅当你需要提供网页/API

平台按需拉起**长驻进程**（首次访问时启动，监听平台分配的随机 `PORT`），你的应用成为一个普通 HTTP 服务，挂在门户的反向代理之下：

- 对外地址：`https://<门户域名>/app/<name>/`（路径模式，注意前缀！）
- 平台替你管：HTTPS、限流、审计、崩溃自动重启（≤3 次，超过不再拉起）、空闲回收、健康探测
- **启动就绪窗口 10 秒**：进程须在 10s 内开始监听 `PORT`，否则当次访问 503「应用启动中」；全局长驻进程数有上限（默认 12，LRU 回收腾位）
- **状态纪律（重要）**：进程**随时会消失重来**——空闲回收（默认 5 分钟无访问，管理端可调）、崩溃重启、配置变更重启、平台重新部署。任务、结果、草稿等跨请求状态**一律落 `aap.db`**（任务表 + 进度列 + 结果 JSON 列 + 前端轮询，模式见 §八案例）；进程内存只放「正在处理中」的瞬时上下文。实测教训：任务放内存字典 → 用户中场休息 5 分钟 → 进程被回收 →「任务不存在」
- **路径前缀注意事项**（最容易踩的坑）：
  - 你的应用对**外**挂 `/app/<name>/`，但平台转发前会**剥掉该前缀**——你的路由挂根路径（`@app.route("/")`、`@app.route("/generate")`），不要自己处理前缀
  - 页面里所有静态资源与接口用**相对路径**（`./static/x.css`），不要写 `/static/x.css`
  - 平台下发 `X-Forwarded-Prefix` 请求头（= `/app/<name>`），需要拼绝对路径时用它
  - 站内相对 `Location` 重定向会被平台镜像补回前缀，无需关心
- **不要依赖 Cookie**：平台剥离沙箱响应的全部 Set-Cookie（防 cookie tossing）；会话态走 `aap.db` + 身份头
- **日志不落运行记录**：persistent 进程的 stdout/stderr 当前不收集（§3.5）——排错靠页面内自诊断信息 / 返回错误文案 / 管理端看进程状态
- 监听 `PORT` 环境变量、bind `127.0.0.1`，**不要自己挑端口**；`app.run(host="127.0.0.1", port=int(os.environ["PORT"]))`
- WebSocket：平台对 persistent 透传 WS（同一套门禁/限流/前缀语义），flask 需额外库的场景受 §1.2 依赖限制约束
- 出站走平台代理（§3.4）；进程内 socket 直连会被运行时网络守卫拦截（仅放行平台回环地址）

### 按用户隔离数据（passUser）

声明 `llm` 能力的**用户上传包自动启用身份注入**；管理员通道上传需在表单勾选「注入用户身份」（**persistent 调 LLM 必须开启**，否则网关按无归因拒绝，见下）。启用后：

- 代理逐请求注入 `x-aap-identity` / `x-aap-identity-sig` 签名头：payload 含 `uid/kind/subject/name/aud/jti/iat/exp`（base64url JSON + HMAC-SHA256 hex 签名，10 分钟 TTL）
- 沙箱环境变量自动注入 `AAP_SIGN_SECRET`（验签密钥，`AAP_` 保留名、包不可覆盖）
- 验签：用 `AAP_SIGN_SECRET` 对 payload 重算 HMAC，`hmac.compare_digest` 比对；校验 `exp` 未过期、`aud == os.environ["AAP_APP_ID"]`；通过后以 `(kind, uid)` 或 `subject` 作账号键——**不要只用 uid**（本地/OIDC 分号段）
- 密钥未注入（未开 passUser）时按不信任处理：拒绝或仅解码展示
- **LLM 计费归因走同一条链**：`aap.llm.chat` 会自动携带当前请求的身份（§3.1）——未开 passUser 的 persistent 包调 LLM 会因「无用户归因」被网关 403 拒绝（除非管理员放行无归因策略）

---

## 三、能力接口（SDK 存根）

平台向 `mod.py` 注入全局对象 `aap`（无需 import、无需任何密钥）。**只存在以下接口，没有别的**：

### 3.1 `aap.llm.chat` / `aap.llm.chat_stream` — 调用大模型

```python
resp = aap.llm.chat(
    messages=[
        {"role": "system", "content": "你是一个财务分析助手"},
        {"role": "user", "content": f"总结 {text} 的要点"},
    ],
    model="glm-4.7",        # 可选；不填用平台默认模型（LLM_DEFAULT_MODEL 设置，未设取目录第一个）
    temperature=0.7,         # 可选
    max_tokens=2000,         # 可选——影响平台预检额度预估，建议写
)
print(resp["content"])       # 助手回复文本
print(resp["usage"])         # {"prompt_tokens":..., "completion_tokens":...}
```

- 返回 dict：`{"content": str, "usage": {...}, "model": str}`。
- 走平台 LLM 网关（OpenAI 兼容），**token 计入发起调用用户**的额度池——你不用管 key、计费、限流；调用者余额不足时抛 `RuntimeError`（内含 402 `INSUFFICIENT_BALANCE`），**务必 try/except 并返回 `{"error": ...}`**。
- manifest 未声明 `llm` 能力 → 抛 `RuntimeError`（403 `CAPABILITY_NOT_DECLARED`）。
- 模型名以管理员模型目录为准，写错抛错（404 model_not_found）；目录为空且未指定 model 也有明确报错。
- 归因身份自动解析：invoked 用平台注入的运行身份；persistent 在 flask 请求上下文内自动取当前请求的 `x-aap-identity*` 头。也可显式传 `identity=(payload, sig)`（从请求头原样取出透传，多线程/非请求上下文场景需要）。
- 不传 `max_tokens` 时生成上限由平台设置 `LLM_SANDBOX_MAX_TOKENS` 统一治理（0 = 不限制）；显式指定可精确控制预检额度预估。
- **流式是伪流式**：`aap.llm.chat_stream(messages, ...)` 返回生成器，逐段 yield 增量文本——底层仍是整段返回后切片（约 8 段），没有真流式接口；SSE 页面呈现需自行权衡。

### 3.2 `aap.db` — 数据库（每包独立 SQLite，支持 SQL）

每个包拥有**独立的 SQLite 数据库**（自动创建，物理隔离，互不可见），在你的库内使用完整 SQL：

```python
# 建表与写入（重复执行请用 CREATE TABLE IF NOT EXISTS）
aap.db.execute("""
    CREATE TABLE IF NOT EXISTS records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_key TEXT NOT NULL,
        code TEXT NOT NULL,
        summary TEXT,
        created_at TEXT DEFAULT (datetime('now'))
    )
""")
aap.db.execute(
    "INSERT INTO records (user_key, code, summary) VALUES (?, ?, ?)",
    ("u_1001", "600519", "……")
)

# 查询 → list[dict]
rows = aap.db.query(
    "SELECT code, summary FROM records WHERE user_key = ? ORDER BY id DESC LIMIT 10",
    ("u_1001",)
)
```

- **边界**：SQL 只作用于你包自己的库；平台业务表与其他包的数据物理隔离、不可访问，没有跨库 join。
- 参数一律用 `?` 占位符传入，不要拼接字符串（防注入是包作者自己的责任）。
- 连接已配置 `check_same_thread=False`（flask 多线程可用）；每次 `execute` 自动 commit，无显式事务接口——批量写入自行合并语句减少调用次数。
- **当前无容量限额**（平台未实装 db 配额）——自律使用，滥用属审核驳回项。

### 3.3 `aap.storage` — 文件存储（每包独立配额）

```python
aap.storage.put("uploads/abc.pdf", binary_bytes)   # → 写入字节数；超配额抛 RuntimeError
data = aap.storage.get("uploads/abc.pdf")           # → bytes
aap.storage.delete("uploads/abc.pdf")
files = aap.storage.list(prefix="uploads/")         # → 排序后的相对路径列表
```

- 配额：单包总量默认 **10MB**（平台当前未暴露配置项）；**没有**独立单文件限额，也没有对外的文件下载 URL——需要给用户交付文件时：小体量可 base64 进返回值/响应，或落 storage 后把键名告诉用户（仅包自身可读回）。

### 3.4 `aap.http.fetch` — 出站 HTTP（走代理，白名单放行）

```python
resp = aap.http.fetch("https://api.example-data.com/v1/quote?code=600519", timeout=15)
# resp: {"status": 上游状态码, "body": 上游响应文本（≤500KB）}

# 需要鉴权的 API：headers 传自定义请求头（密钥从 os.environ 取，不要硬编码）
resp = aap.http.fetch(
    "https://api.example-data.com/v2/check",
    timeout=15,
    headers={"Key": os.environ["EXAMPLE_API_KEY"], "Accept": "application/json"},
)
```

- 域名必须**逐条写在 manifest `network`**（精确域名或 `*.example.com` 通配；写 host 即可，协议/路径会被截掉）；未声明域名被代理拒绝（抛 `RuntimeError`）。
- **仅支持 GET**；`timeout` 默认 15 秒（平台侧出站硬上限约 15s，传更大无效）。
- `headers` 上限 16 个、单值 ≤4096 字符；逐跳与托管头（Host/Connection/Content-Length/Content-Type/Proxy-* 等）被平台剥除。
- 重定向由平台逐跳复核白名单后跟进（最多 5 跳）；解析到内网/保留 IP 的域名一律拒绝（管理员可为内网部署配置放行白名单，与包无关）。
- 平台侧拒绝（白名单/URL 非法/出站失败）以 `RuntimeError` 抛出；上游业务错误码经 `resp["status"]` 判断——**逐分支处理，别把 401/429 当成功**。

### 3.5 `aap.log` — 日志

用 `aap.log` 或 `logging.getLogger("aap")`（**必须叫 `aap`** 这个 logger 名——handler 挂在它上面，用模块级 `logging.info` 走 root logger 不进收集通道）。

```python
aap.log.debug("解析输入: code=%s", code)         # 过程细节（仅本地 aap-dev 可见，见下）
aap.log.info("开始生成摘要 model=%s", model)     # 关键业务动作
aap.log.warning("上游返回空，使用降级文案")       # 可恢复异常
aap.log.error("生成失败: %s", err)               # 失败（同时按规范返回 {"error": ...}）
```

**收集现状（按运行模式，务必了解）**：

| 模式 | 日志去向 |
|---|---|
| invoked | stderr 被平台捕获，运行记录保留**末尾约 8KB**（超出静默截断，无标记）；`DEBUG` 级不输出（平台固定 INFO 起步） |
| persistent | **当前不收集**（进程 stdout/stderr 丢弃）——排错靠页面自诊断/错误文案 |
| 本地 aap-dev | `AAP_DEBUG=1`，DEBUG 起全量输出到终端 |

**硬性要求**：
1. **禁止 `print()`**：invoked 下 stdout 是结构化出参协议载体，print 会污染协议。
2. **脱敏**：不打 API key/token/密码/环境变量值；用户敏感数据打掩码（`u_100***`、`138****1234`）。
3. **限量**：运行记录只留末尾约 8KB——高频循环不要逐条打日志，聚合成一条。
4. **日志不是返回值**：业务结果走 `return` / HTTP 响应，别让用户「去日志里找结果」。

### 3.6 统一页面元素（persistent 必读）

平台会在 persistent 应用的 HTML 响应中**自动注入**门户悬浮条（右上角：**应用门户 / 个人中心 / 退出登录**，已登录时另显示用户名；注入失败静默、不阻断业务）。约定：

1. **不得遮挡、覆盖或隐藏**悬浮条——不要放全屏遮罩、不要用 `z-index` 压住右上角区域。
2. 页面右上角**预留空间**（建议 220×48px 起始区域空出），你的导航请避开。
3. **不要自己实现登录/登出/个人中心入口**——会话由门户统一管理，自建入口会破坏单点登录状态。

### 3.7 沙箱前端纪律（HTML 工具与 persistent 页面通用）

用户上传的应用在门户里经 iframe 沙箱运行（`sandbox` 属性**不含** `allow-same-origin` → opaque origin；raw 通道响应另有 CSP `sandbox` + `object-src 'none'` + `base-uri 'none'`），前端必须遵守：

1. **禁用 `localStorage` / `sessionStorage` / `document.cookie`**——opaque origin 下访问直接抛 `SecurityError`，所在脚本段整段崩掉。持久化交给后端落 `aap.db`，页面状态用内存变量。
2. **禁用 `<base>` 标签**——raw 通道 CSP 为 `base-uri 'none'`，写了不生效。
3. **密钥零出现**：配置/密钥走门户「环境变量」（§1.1）注入服务端、经 `os.environ` 读取；前端输入框收集密钥 = 设计错误。
4. 全部资源与接口用**相对路径**（`./api/x`、`./static/x.css`），不要写 `/api/x`——应用挂在 `/app/<name>/` 之下；HTML 工具**无法调用门户 `/api`**（opaque origin 被 CORS 拦），必须完全自包含。
5. 剪贴板 `navigator.clipboard` 在沙箱下可能被拒，必须带 `document.execCommand('copy')` 降级。
6. **HTML 工具同样要右上角留白**：门户悬浮条压在外壳层顶部（全屏 iframe 之上），你的页面内容请避开右上角（同 §3.6 尺寸建议）。

---

## 四、mod.py 模板

### invoked 模板（数据处理 / LLM 工具）

```python
# manifest: type=python, runtime=invoked, capabilities=["llm"]

def handle(input: dict, aap) -> dict:
    """
    input  = 工具页提交的 JSON（平台不做 schema 校验——自行防御缺字段/类型错）
    return = 渲染给用户的结构化结果（须可 JSON 序列化）
    """
    code = input.get("code")                    # 缺字段给可读错误，不要裸 KeyError
    if not code:
        return {"error": "缺少参数：code（股票代码）"}
    text = input.get("note", "")

    aap.log.info("收到摘要请求 code=%s", code)
    try:
        resp = aap.llm.chat(
            messages=[
                {"role": "system", "content": "你是财务摘要助手，输出 JSON"},
                {"role": "user", "content": f"股票 {code}，备注 {text}，生成三句话摘要"},
            ],
            max_tokens=800,
        )
    except Exception as err:                    # noqa: BLE001 — 顶层兜底（余额不足/模型错误都在这）
        aap.log.error("LLM 调用失败: %s", err)
        return {"error": f"摘要生成失败：{err}"}

    aap.log.info("摘要完成 model=%s tokens=%s", resp.get("model"), resp.get("usage"))
    return {
        "summary": resp["content"],
        "model": resp["model"],
    }
```

入参字段名由你约定，工具页默认以 JSON 输入框提交（§二 invoked）；交付说明里附一段示例：

```json
{"code": "600519", "note": "侧重风险"}
```

### persistent 模板（网页 / API 服务）

```python
# manifest: type=python, runtime=persistent, capabilities=["llm","db"], name="writer"
import hmac, hashlib, json, os
from flask import Flask, request, jsonify   # flask 平台预置，无需声明依赖

app = Flask(__name__)

def current_user_key() -> str:
    """passUser 身份验签（§二）：HMAC + exp + aud，通过后以 subject 作账号键。"""
    p = request.headers.get("x-aap-identity", "")
    s = request.headers.get("x-aap-identity-sig", "")
    secret = os.environ.get("AAP_SIGN_SECRET", "")
    if not (p and s and secret):
        return "anonymous"
    expect = hmac.new(secret.encode(), p.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expect, s):
        return "anonymous"
    try:
        payload = json.loads(__import__("base64").urlsafe_b64decode(p + "==="))
        if payload.get("aud") != os.environ.get("AAP_APP_ID"):
            return "anonymous"
        return str(payload.get("subject") or payload.get("uid"))
    except Exception:
        return "anonymous"

@app.route("/")
def home():
    # 相对路径；路由挂根（前缀由平台剥除）；右上角留白给门户悬浮条（§3.6）
    return '<h1>写作助手</h1><form action="./generate" method="post"><input name="topic"><button>生成</button></form>'

@app.route("/generate", methods=["POST"])
def generate():
    try:
        resp = aap.llm.chat(messages=[{"role": "user", "content": request.form["topic"]}])
    except Exception as err:
        return jsonify({"error": f"生成失败：{err}"}), 200   # 错误也走 200+error 字段，前端好处理
    return jsonify({"text": resp["content"]})

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ["PORT"]))   # PORT 平台注入，不要自选
```

---

## 五、硬性约束与交付自检（违反 = 审核不过或运行报错；交付前逐条勾）

**manifest 与能力声明**

- [ ] manifest 各字段齐备且合规（name 正则 / type / entry 相对路径 / runtime 枚举 / capabilities 只含 llm·db·storage）；`capabilities` / `network` / `runtime` / `env` / `requirements` 与代码实际行为**严格一致**（审批照单，改声明 = 重新提审；`llm` 有运行时硬闸，db/storage 谎报直接驳回）
- [ ] 外部配置项已声明 manifest `env`（§1.1）：必填/可选、secret、pattern 划分正确，代码经 `os.environ` 读取，未声明平台保留变量名
- [ ] 没有硬编码任何密钥/令牌；没有绕过平台向使用者索要密钥（前端输入框收 key = 设计错误）
- [ ] 依赖面自查：只用标准库 + 预置 flask + `requirements` 声明的依赖；**面向普通用户自传场景只用标准库 + flask**（§1.2 用户通道不装依赖）

**代码边界**

- [ ] Python 包 `mod.py` 为入口（可带静态资源目录）；无运行时自装依赖
- [ ] 无自建网络出口（不经 `aap.http.fetch` 的出站一律禁止；socket 直连会被运行时守卫拦截——绕守卫属审核驳回项）；域名全部在 manifest `network`，上游状态码 `resp["status"]` 逐分支处理
- [ ] invoked 出入参可 JSON 序列化（二进制落 `aap.storage` 回键名或小体量 base64，**没有文件下载 URL 机制**）；单次执行 < 30s
- [ ] 错误路径友好：失败返回 `{"error": "人类可读的中文说明"}`；LLM/出站调用全部 try/except

**运行时状态**

- [ ] invoked 无状态（进程即毁）
- [ ] persistent 状态纪律：任务/结果/草稿/每用户配置落 `aap.db`，不依赖进程内存（空闲回收约 5 分钟，§二）
- [ ] persistent：`PORT` + `127.0.0.1` + 路由挂根 + 相对路径 / `X-Forwarded-Prefix`；不依赖 Cookie（Set-Cookie 被剥离）
- [ ] 按门户用户隔离数据：行键自带 user_key（persistent 从 `x-aap-identity` 头验签解码，§二；invoked 无调用者身份，需要时由 input 显式携带并在说明中声明信任边界）
- [ ] persistent 调 LLM 的包：确认 passUser 已启用（用户通道声明 llm 自动开启；管理通道需勾选）——否则网关 403 无归因拒绝

**日志（§3.5）**

- [ ] 只用 `aap.log` / `logging.getLogger("aap")`，没有 `print()`；级别语义正确（DEBUG 本地才可见）；敏感信息与环境变量值脱敏；高频循环聚合；总量控制在末尾 8KB 内能容纳关键信息

**前端（HTML 工具与 persistent 页面通用，§3.7）**

- [ ] 无 localStorage / sessionStorage / cookie 依赖；无 `<base>` 标签；无密钥收集；剪贴板带 `execCommand('copy')` 降级；资源与接口全部相对路径
- [ ] HTML 工具完全自包含（沙箱内调不了门户 `/api`）；右上角留白（建议 220×48px）不遮挡门户悬浮条；没有自建登录/登出入口（§3.6）

**交付**

- [ ] 已在本地 aap-dev 跑通**非网络路径**（db/storage/log；llm/http 本地无法调用，§七）；涉及 llm/http 的包以上传后试运行验证
- [ ] 交付物 = ZIP 包 + 「如何自测」说明（入参 JSON 示例 / 环境变量配置清单 / 依赖是否需管理员安装）

## 六、交付与上架流程

```
本地 aap-dev 自测（§七：跑通 invoked 非网络路径、看 DEBUG 日志）
   ↓  打包 ZIP（manifest.json + mod.py[/index.html + 静态资源]）
   ↓  上传门户 → 自动校验：manifest 契约 + 包体限制（≤2000 条目 / 解压 ≤100MB / 用户每日 20 次）+ Ed25519 签名四态判定
   ↓  默认「私有」：上传者自己可见可用 ←— 上传后先试运行！invoked 的日志在运行记录里看
   ↓  「提交审核」→ 管理员看代码 + 试运行
   ↓  通过 → 可见性设为公开/指定可见：门户其他用户可用
       （驳回带理由，改完重新提审；官方签名包 verified 自动免审）
```

**版本更新语义（重要）**：
- **已公开/需登录/指定可见**的应用推未审新版：平台**先把应用下线**（他人不可访问），审核通过自动恢复上线——不存在「未审新版即时对他人生效」。
- **私有**应用推新版即时生效（本来就只有归属者可见）。
- 同名包仅**归属者或管理员**可更新（用户通道）；管理员上传通道遇同名直接 409（需删除后重传）。
- 更新会重新走签名判定与审核；依赖仅在管理员通道重装（§1.2）。

给用户交付时：提供 ZIP 包 + 一段「如何自测」说明（本地 aap-dev 自测 → 上传 → 私有可见 → 试运行 → 提审）。

## 七、本地调试沙箱（aap-dev）

平台提供本地调试 CLI：与线上**共用同一 SDK 构造器**（`build_aap()`），行为一致的部分是 db/storage/log 与 handle 执行协议；差异见下。

```bash
python3 packages/aap-sdk/aap_dev.py run mod.py --input input.json   # --input 缺省读 stdin
python3 packages/aap-sdk/aap_dev.py run mod.py --reset              # 顺带清空本地 db/storage（.aap-dev/ 目录）
```

**本地可用**：
- `aap.db` / `aap.storage`：映射到 `./.aap-dev/`（db.sqlite / storage/），`--reset` 清空
- `aap.log`：`AAP_DEBUG=1` 自动开启，DEBUG 起全量输出到终端
- handle 入参/返回协议与线上一致

**本地不可用（不要在本地验证这些路径）**：
- `aap.llm.chat` / `aap.http.fetch`：需要平台回环服务 + 网关凭据（`AAP_TOKEN`），本地两者皆无——调用会抛「平台接口错误(连接失败)」。涉及这两个接口的包，**上传后试运行才是权威验证**。
- **白名单与能力闸不在本地强制**：执行点在平台代理/网关侧，本地没有平台就没有校验——本地跑通 ≠ 白名单放行，manifest `network` 写漏的包本地发现不了。
- persistent（serve）、`--llm real`、`--submit` 未实装，勿依赖。

## 八、实战案例与坑清单

### 8.1 把现有 Web 项目重构为 .neon-aap 的方法论

移植/重构的实质是**逐项替换自建设施为平台能力**，业务逻辑保留：

| 自建设施 | 平台替代 |
|---|---|
| 用户/登录/OIDC/人机验证 | 门户统一账号 + passUser 身份头（`x-aap-identity` 验签，§二） |
| LLM 接入（多上游/key/计费） | `aap.llm.chat` + 自动归因（按浏览用户扣费；余额不足 402 要兜底） |
| 密钥/配置保管 | manifest `env`（§1.1）+ 门户环境变量 |
| 中心数据库 | `aap.db`（行键带 user_key 隔离各用户） |
| 审计/运行记录 | 平台运行记录 + audit_logs（自动；注意 persistent 日志不收集） |
| 出站 API 调用 | `aap.http.fetch` + manifest `network` 白名单 |

**案例 A · ip-analyzer**（Flask+AbuseIPDB → persistent 包，`examples/ip-analyzer/`）：
五个替换——requests→`aap.http.fetch`（鉴权头）、密钥 UI 收集→`env` 注入、socket 反查删除、localStorage 清除、任务状态落 `aap.db`。

**案例 B · llm-proofread**（React19+Express+tRPC+MySQL → 全新 persistent 包）：
自建用户系统、LLM 多上游接入、密钥保管、审计日志**整体删除**；包内只剩校对编排、规则引擎、diff 呈现、每用户提示词/词库（aap.db）。完整设计见仓库内 `ai-app-portal-docs/llm-proofread-aap-design.md`（平台仓库参考，门户用户可忽略）。

### 8.2 坑清单（全部实测踩过；只列带独立诊断症状的条目，规则本体见 §二 / §3.x / §五）

| 坑 | 症状 | 正确做法 |
|---|---|---|
| persistent 进程内存放任务/结果 | 空闲回收（约 5 分钟）后「任务不存在」 | 状态落 `aap.db`（§二 状态纪律） |
| persistent 路由自己拼 `/app/<name>` 前缀 | 反代剥前缀后 404 | 路由挂根（`@app.route("/")`），前缀交给平台 |
| `socket` / 直连网络 | 运行时网络守卫报错「仅允许访问平台」 | `aap.http.fetch`（headers 带鉴权头，§3.4） |
| 忽略 `resp["status"]` | 上游 401/429 被当成功处理 | fetch 返回上游状态码，逐分支处理 |
| LLM 调用不 try/except | 用户余额不足（402）时整页 500 | 捕获 RuntimeError → 返回 `{"error": ...}` |
| persistent 未开 passUser 调 LLM | 网关 403「无归因拒绝」 | 声明 llm（用户通道自动开）/管理通道勾选 passUser |
| 依赖第三方库、用户自传 | 运行时 `ModuleNotFoundError` | 只用标准库+flask，或走管理员通道（§1.2） |
| persistent 响应 Set-Cookie | 被门户剥离，浏览器拿不到 | 会话态落 `aap.db` + 身份头 |
| 前端用 localStorage / `<base>` | `SecurityError` 整段崩 / base 不生效 | 内存变量；删 `<base>`（§3.7） |
| `print()` 调试 | invoked 下污染 JSON 出参协议 | `aap.log` / `getLogger("aap")`（§3.5） |

---

*本规范由 ai-app-portal 平台维护；接口面（§三）变更必须升版本并同步 `app-develop-internal.skill.md` 的平台实现约定。v0.2.7 为「文档对齐实现」修订：所有「平台将会…」类承诺均已核对平台 v0.1.4 代码实态，未实装能力一律标注现状而非愿景。*

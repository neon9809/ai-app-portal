---
name: neon-aap-develop
description: "当用户要求开发、打包或重构 .neon-aap 应用（AI应用门户扩展包）时使用：manifest 契约、aap.* 能力接口、沙箱纪律与交付自检。"
---

# app-develop.skill.md

> AI应用门户（ai-app-portal）应用开发规范 · 供开发 Agent 使用
> 版本 v0.2.6（2026-09）· 配套平台 PRD v0.3+
>
> **v0.2.6 变更**：manifest 新增 `requirements` 字段（§1.2 pip 依赖声明，声明制=审批依据）——超出标准库+平台预置框架的第三方库在 manifest 列出，**上传时平台自动 `pip install`**（只装 wheel）到应用私有目录，沙箱内直接 import，失败=上传被拒；版本更新不再声明的依赖自动清除。新平台增设「pip 索引源」设置（PIP_INDEX_URL，国内镜像）。native/FPK 形态启动时自检补装预置框架 flask（此前仅 docker 镜像预装，宿主缺 flask 时 persistent 包静默 503 崩溃循环——llm-proofread 实测案例）。§一/§五 同步。
>
> **v0.2.5 变更**：passUser 应用身份验签密钥自动下发——勾选「注入用户身份」的 .aap 包，沙箱环境变量自动注入 `AAP_SIGN_SECRET`（平台全局身份签名密钥；`AAP_` 保留名，manifest.env 不可声明覆盖），persistent 应用可直接本地验签 `x-aap-identity` 头按用户隔离数据（§二 persistent、§五）；后台轮换密钥或切换 passUser 开关会自动停起 persistent 进程，改完即生效。上游（external）应用接入时在管理后台应用表单复制 `AAP_SIGN_SECRET` 自行配置。
>
> **v0.2.4 变更**：补 skill frontmatter（可安装自动触发）；原 §五硬性约束与 §七自检清单**合并为单一清单**（同一规则不再多处复述）；原 §八 aap-dev 按当前实装收窄（run + mock；serve/--llm real/--submit 随平台 M4 提供，勿当作已可用）；坑清单精简为带症状增量的条目；全文重编号（原§八→§七、原§九→§八）。
>
> **v0.2.3 变更**：新增 §3.7 沙箱前端纪律（禁 localStorage/密钥收集、剪贴板降级等）；§二 persistent 增加**状态纪律**（进程会被空闲回收/重启，跨请求状态一律落 aap.db）；新增 §九 实战案例与坑清单（ip-analyzer 移植 / llm-proofread 重构设计）。§五、§七 同步。
>
> **v0.2.2 变更**：manifest 新增 `env` 字段（§1.1 环境变量 / 机密声明）——需要 API key 等配置的包不再硬编码，改为 manifest 声明变量名（必填/可选、是否密钥、格式校验、默认值），上传后由归属者/管理员在门户填值（密钥 AES-256-GCM 加密存储、界面只写不读），沙箱启动时自动注入为进程环境变量（`os.environ` 直接读）。§3.4 `aap.http.fetch` 支持 `headers` 自定义请求头并透传上游状态码（鉴权 API 场景）。§五 硬性约束与 §七 自检清单同步。
>
> **v0.2.1 状态标注**：HTML 包门户托管已上线（上传即托管生效）；Python 沙箱运行时（invoked / persistent）已实装。统一页面元素（§3.6）与 LLM 自动签发已实装：包上传即自动配置网关凭据，无需任何手动操作；声明 `llm` 能力的包开放模型调用，未声明的包对 LLM 接口一律 403（能力闸在网关侧强制，绕过代理直连 `/v1` 同样生效）。
>
> **v0.2 变更**：新增 §3.5 日志规范（开发/运行日志统一收口 portal）、§3.6 统一页面元素（返回个人中心/退出登录按钮）、§八 本地调试沙箱（aap-dev）；§五 硬性约束与 §七 自检清单同步。

---

## 你是谁、要做什么

你正在为 **AI应用门户** 开发一个新应用。用户会告诉你需求设想；你的产出是一个符合本规范的 **`.neon-aap` 包**（ZIP 文件），用户拿到后上传门户即可安装使用。

`.neon-aap` = **ai-app-portal** 的缩写。包内只有两种形态，按需求二选一：

| 形态 | 适合 | 包内容 |
|---|---|---|
| **HTML 工具** | 纯前端：格式转换、计算器、文本处理（可自带 JS） | `manifest.json` + `index.html` + 静态资源 |
| **Python 应用** | 需要 LLM / 数据库 / 存储 / 对外提供网页或 API | `manifest.json` + `mod.py`（单文件） |

---

## 一、manifest.json（必读，能力全靠它声明）

```jsonc
{
  "name": "stock-summary",          // 包标识：小写字母数字连字符，全局唯一
  "display_name": "股票摘要助手",
  "version": "1.0.0",
  "type": "python",                  // "html" | "python"
  "entry": "mod.py",                 // python 必填；html 固定 index.html；仅限包内相对路径（含 ../ 或绝对路径上传即拒）
  "description": "输入股票代码，生成中文投资摘要",
  "author": "someone",
  "runtime": "invoked",              // "invoked" 按调用 | "persistent" 持久服务（仅 python）
  "capabilities": ["llm", "db"],     // 按需声明：llm / db / storage，不用的不要写
  "network": [                       // 出站域名白名单（无需联网则留空数组）
    "api.example-data.com"
  ],
  "env": {                           // 环境变量/机密声明（v0.2.2，见 §1.1；无需配置则省略）
    "ABUSEIPDB_API_KEY": { "required": true, "secret": true, "pattern": "^[a-f0-9]{80}$", "description": "AbuseIPDB 密钥" },
    "MAX_CONCURRENCY": { "required": false, "default": "4", "description": "并发上限" }
  },
  "requirements": ["flask>=3.0"],    // pip 依赖声明（v0.2.6，见 §1.2；只作标准库+预置框架则省略）
  "route": "stock-summary"           // 仅 persistent：门户内的路由前缀 /app/stock-summary/
}
```

**铁律**：
1. `capabilities` 和 `network` 是**审批依据**——写了什么，管理员就按什么审；上线后想改白名单 = 重新提审。
2. 不声明的能力**调用会直接报错**。宁少勿多，按需申请。
3. `runtime: "persistent"` 会常驻占用资源，审查更严：没有持续服务需求的（哪怕要调 LLM）一律用 `invoked`。

### 1.1 env——环境变量 / 机密声明（v0.2.2）

需要外部配置（第三方 API key、模型名、阈值……）时，**在 manifest `env` 里声明，不要写死在代码里，更不要自己要求用户把 key 交给你**：

```jsonc
"env": {
  "变量名": "描述",                                    // 速记：= required 必填
  "变量名": { "required": true, "secret": true, "pattern": "^…$", "default": "…", "description": "…" }
}
```

| 字段 | 说明 |
|---|---|
| `required` | 默认 `true`。必填变量未配置时，平台**拒绝执行/拉起**并明确提示缺哪个 |
| `secret` | 默认 `false`。`true` = 机密：AES-256-GCM 加密落盘，门户界面只写不读（仅显示尾 4 位提示） |
| `pattern` | 可选，简单格式校验正则（保存配置时执行；自行带 `^` `$` 锚点） |
| `default` | 可选，未配置时注入的默认值（**机密变量不允许 default**；值须为字符串） |
| `description` | 展示在配置界面，告诉填写者这是什么 |

**行为与纪律**：
- 值由**归属者/管理员**上传后在门户「环境变量」里填（用户中心·我的应用 / 管理后台·应用管理都有入口）；沙箱每次启动时注入为进程环境变量，代码里直接 `os.environ["变量名"]` 读。

### 1.2 requirements——pip 依赖声明（v0.2.6）

代码需要的第三方库（超出标准库 + 平台预置框架的部分）**在 manifest `requirements` 里声明，上传时平台自动安装**到应用私有目录，沙箱内直接 `import`，不允许任何形式的运行时自装：

```jsonc
"requirements": ["flask>=3.0", "requests==2.32.3", "beautifulsoup4"]
```

- **声明制 = 审批依据**：与 `capabilities`/`network` 同一哲学，管理员审核时照单看依赖；改依赖 = 重新提审。
- **写法**：标准 pip 需求串（`名称[extras] 版本约束`）；**建议带版本上限或精确版本**（不带约束 = 安装当时最新版，升级后行为可能变）。不支持 URL / 本地路径 / `-r`（上传即拒）。
- **安装时机**：上传/版本更新时平台执行 `pip install --only-binary=:all: --target <应用目录>/.deps`；**失败 = 上传被拒**，错误原样返回（网络/镜像源问题调平台「pip 索引源」设置）。
- **只装 wheel**：无预编译 wheel 的源码包（含需编译 C 扩展且平台无对应 wheel 的）装不了，上传时会明确报错——换纯 Python 等价库或联系管理员。
- 版本更新不再声明的依赖会被清掉；依赖装在应用数据目录下，平台升级/重建不影响。
- persistent 应用修改配置后会自动重启进程（下次访问生效）；invoked 天然每次生效。
- **保留名不可声明**：`AAP_*`、`PORT`、`PATH`、`HOME`、`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`、`PYTHON*`、`SSL_CERT_*`、`SANDBOX_*`、`NODE_OPTIONS` 等（平台注入面，声明即上传失败）。
- 单包最多 16 个变量；值长度 ≤ 8192 字符；日志纪律同样适用——**不要把环境变量值打进 `aap.log`**。

---

## 二、运行时模型（python）

### invoked（按调用）——默认选择

每次用户发起调用，平台**起一个全新进程**执行你的 `mod.py`，拿到返回后进程即销毁。

```
用户点工具 → 填表单提交 → 平台起进程 → 执行 handle() → 返回 JSON → 进程销毁
```

- 无状态！不要依赖进程内存保存任何东西（需要就写 db/storage）
- 单次执行有超时限制（平台默认，勿做长任务）
- 入口函数签名见下文模板

### persistent（持久服务）——仅当你需要提供网页/API

平台拉起**长驻进程**，你的应用成为一个普通 HTTP 服务，挂载在门户的反向代理之下：

- 对外地址：`https://<门户域名>/app/<route>/`（路径模式，注意前缀！）
- 平台替你管：HTTPS、限流、审计、健康检查、崩溃重启、空闲回收
- **状态纪律（重要，v0.2.3）**：上面这些管理手段意味着**进程随时会消失重来**——空闲回收（默认约 5 分钟无访问）、崩溃重启、平台重新部署。任务、结果、草稿等跨请求状态**一律落 `aap.db`**（任务表 + 进度列 + 结果 JSON 列 + 前端轮询，模式见 §八）；进程内存只放「正在处理中」的瞬时上下文。实测教训：任务放内存字典 → 用户中场休息 5 分钟 → 进程被回收 → 「任务不存在」
- **路径前缀注意事项**（重要，最容易踩的坑）：
  - 你的应用挂在 `/app/<route>/` 之下，不是根路径
  - 页面里所有静态资源用**相对路径**（`./static/x.css`），不要写 `/static/x.css`
  - 支持 `X-Forwarded-Prefix` 请求头：用它拼绝对路径更稳
  - **不要依赖 Cookie**：门户剥离沙箱响应的 Set-Cookie（防 cookie tossing），会话态走 `aap.db` + 身份头（§五.8）
- **按用户隔离数据（passUser，v0.2.5）**：接入时勾选「注入用户身份」的包，代理逐请求注入 `x-aap-identity` / `x-aap-identity-sig` 签名头（payload 含 `uid/kind/subject/aud/jti/exp`），同时沙箱环境变量自动注入 `AAP_SIGN_SECRET`——用它重算 HMAC 并 `timingSafeEqual` 比对验签（校验 `exp` 未过期、`aud` 等于本包 `AAP_APP_ID`），通过后以 `(kind, uid)` 或 `subject` 作账号键。账号键不要只用 `uid`（本地/OIDC 分号段）
- 监听端口由平台通过环境变量注入（`PORT`），bind 到 `127.0.0.1`，**不要自己挑端口**
- 进程无外网，出站走平台代理（见下文网络）

---

## 三、能力接口（SDK 存根）

平台向 `mod.py` 注入全局对象 `aap`（无需 import、无需任何密钥）。**只存在以下接口，没有别的**：

### 3.1 `aap.llm.chat(messages, **opts)` — 调用大模型

```python
resp = aap.llm.chat(
    messages=[
        {"role": "system", "content": "你是一个财务分析助手"},
        {"role": "user", "content": f"总结 {text} 的要点"},
    ],
    model="glm-4.7",        # 可选；不填用平台默认模型
    temperature=0.7,         # 可选
    max_tokens=2000,         # 可选，建议写——影响预检额度预估
)
print(resp["content"])       # 助手回复文本
print(resp["usage"])         # {"prompt_tokens":..., "completion_tokens":...}
```

- 走平台 LLM 网关（OpenAI 兼容），**token 计入发起调用的用户**的额度池——你不用管 key、计费、限流
- 模型名以门户管理员的模型目录为准；写错会返回明确错误
- 支持流式：`stream=True` 时返回迭代器，逐段 yield 增量文本
- 不传 `max_tokens` 时的生成上限由平台设置 `LLM_SANDBOX_MAX_TOKENS` 统一治理（0 = 不限制）；显式指定可精确控制预检额度预估

### 3.2 `aap.db` — 数据库（每包独立 SQLite，支持 SQL）

每个包拥有**独立的 SQLite 数据库**（自动创建、自动带包名命名空间，互不可见），在你的库内使用完整 SQL：

```python
# 建表与写入（首次会自动执行，重复执行请用 CREATE TABLE IF NOT EXISTS）
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

- **边界**：SQL 只作用于你包自己的库；平台业务表与其他包的数据**物理隔离、不可访问**，也没有跨库 join
- 参数一律用 `?` 占位符传入，不要拼接字符串（防注入是包作者自己的责任）
- 有容量限额（平台配置），超限报错；批量写入建议包在事务语义里（平台自动 commit）
- 典型用法：**任务/结果表**（persistent 状态纪律，§二）、**按门户用户隔离的数据**（行键带 user_key，见 §五；persistent 下用户身份从 `x-aap-identity` 头解码）

### 3.3 `aap.storage` — 文件存储（每包独立配额）

```python
aap.storage.put("uploads/abc.pdf", binary_bytes)
data = aap.storage.get("uploads/abc.pdf")            # → bytes
aap.storage.delete("uploads/abc.pdf")
files = aap.storage.list(prefix="uploads/")
```

- 适合用户上传件、生成结果缓存；有单包容量与单文件大小限额

### 3.4 出站 HTTP — 走代理，白名单放行

```python
resp = aap.http.fetch("https://api.example-data.com/v1/quote?code=600519")
# resp: {"status": 上游状态码, "body": 上游响应文本（≤500KB）}

# 需要鉴权的 API：headers 传自定义请求头（密钥从 os.environ 取，不要硬编码）
resp = aap.http.fetch(
    "https://api.example-data.com/v2/check",
    headers={"Key": os.environ["EXAMPLE_API_KEY"], "Accept": "application/json"},
)
```

- 域名必须**逐条写在 manifest `network`**，未声明域名直接被代理拒绝
- 执行点在平台代理侧，代码里无法绕过（也没有 socket / os.system 可用）
- 仅支持 GET；`headers` 中的逐跳头（Host/Connection/Content-Length 等）会被平台剥除
- 无需自己处理 TLS/代理细节，fetch 直给结果（平台侧拒绝以异常抛出，上游错误码经 `resp["status"]` 判断）

### 3.5 `aap.log` — 日志（平台统一收口，v0.2 新增）

平台向 `mod.py` 注入配置好的日志处理器。用 `aap.log` 或标准 `logging` 都可以（同一个处理器），**所有日志都会被收口进门户的运行记录**——本地调试、上传后试运行、线上调用，全部走这一条通道。不要也不可能自建日志出口（沙箱内无网络、无文件写权限，写日志旁路既不可用也不合规）。

```python
aap.log.debug("解析输入: code=%s", code)         # 过程细节
aap.log.info("开始生成摘要 model=%s", model)     # 关键业务动作
aap.log.warning("上游返回空，使用降级文案")       # 可恢复异常
aap.log.error("生成失败: %s", err)               # 失败（同时按规范返回 {"error": ...}）
```

**级别语义**（平台按级别决定线上保留策略）：

| 级别 | 用途 | 线上保留 |
|---|---|---|
| `DEBUG` | 过程细节、中间值，帮助排查问题 | 否（仅本地调试/试运行保留） |
| `INFO` | 关键业务动作与结果（开始了什么、完成了什么、用了哪个模型） | 是 |
| `WARNING` | 可自动恢复的异常、降级、重试 | 是 |
| `ERROR` | 失败；必须配合返回 `{"error": "人类可读中文说明"}` | 是 |

**硬性要求**：
1. **禁止 `print()`**：stdout 是结构化出参通道（invoked 模式下协议载体），print 会污染协议、日志丢失。
2. **脱敏**：不打 API key/token/密码；用户敏感数据（手机号、邮箱、正文原文）打掩码（如 `u_100***`、`138****1234`）。
3. **限量**：单次运行日志有条数与字节上限（平台配置，超限截断并在运行记录里标记 truncated）；高频循环内不要逐条打 DEBUG，聚合成一条。
4. **日志不是返回值**：业务结果走 `return` / HTTP 响应；日志只做观测，别让用户"去日志里找结果"。

### 3.6 统一页面元素（persistent 必读，v0.2 新增）

平台会在你的 HTML 响应中**自动注入**门户统一的悬浮条（复用反代 HTML 注入机制，注入失败静默、不阻断你的业务），内容为：**应用门户 / 个人中心 / 退出登录**（已登录时另显示用户名）。约定如下：

1. **不得遮挡、覆盖或隐藏**这两个按钮——不要放全屏遮罩、不要用 `z-index` 压住右上角区域。
2. 页面右上角**预留空间**（建议 220×48px 起始区域空出），你的导航请避开。
3. **不要自己实现登录/登出/个人中心入口**——会话由门户统一管理，自建入口会破坏单点登录状态。
4. **HTML 工具无需任何处理**：它们嵌在门户 shell 的 iframe 里，顶部 chrome（返回/退出/用户名）由门户天然提供。

### 3.7 沙箱前端纪律（HTML 工具与 persistent 页面通用，v0.2.3）

用户上传的应用在门户里经 iframe 沙箱（opaque origin）运行，前端必须遵守：

1. **禁用 `localStorage` / `sessionStorage` / `document.cookie`**——沙箱下访问直接抛
   `SecurityError`，所在脚本段整段崩掉。需要持久化交给后端落 `aap.db`，页面状态用内存变量。
2. **密钥零出现**：配置/密钥走门户「环境变量」（§1.1）注入服务端、经 `os.environ` 读取；
   前端输入框收集密钥 = 设计错误（泄露面大，且与平台计费/审计脱节）。
3. 全部资源与接口用**相对路径**（`./api/x`、`./static/x.css`），不要写 `/api/x`——
   应用挂在 `/app/<id>/` 之下。
4. 剪贴板 `navigator.clipboard` 在沙箱下可能被拒，必须带 `document.execCommand('copy')` 降级。
5. 右上角留白给门户统一悬浮条（persistent 见 §3.6；HTML 工具由 shell 天然提供）。

---

## 四、mod.py 模板

### invoked 模板（数据处理 / LLM 工具）

```python
# manifest: type=python, runtime=invoked, capabilities=["llm"]

def handle(input: dict, aap) -> dict:
    """
    input  = 用户表单提交的结构化数据（平台已按 manifest 校验）
    return = 渲染给用户的结构化结果
    """
    code = input["code"]                       # 表单字段名 = 你的入参名
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
    except Exception as err:                   # noqa: BLE001 — 顶层兜底
        aap.log.error("LLM 调用失败: %s", err)
        return {"error": "摘要生成失败，请稍后重试"}

    aap.log.info("摘要完成 model=%s tokens=%s", resp.get("model"), resp.get("usage"))
    return {
        "summary": resp["content"],
        "model": resp["model"],
    }
```

用户侧表单字段由门户根据你在门户上配置的入参 Schema 生成（上传包后在管理后台/个人工具页可见），`input` 的键与之对应。

### persistent 模板（网页 / API 服务）

```python
# manifest: type=python, runtime=persistent, capabilities=["llm","storage"], route="writer"
import os
from flask import Flask, request, jsonify   # 平台预置常用 Web 框架，无需自带依赖

app = Flask(__name__)

@app.route("/")
def home():
    # 注意：相对路径；前缀由平台注入；右上角留白给门户统一按钮（见 §3.6）
    return '<h1>写作助手</h1><form action="./generate" method="post"><input name="topic"><button>生成</button></form>'

@app.route("/generate", methods=["POST"])
def generate():
    resp = aap.llm.chat(messages=[{"role": "user", "content": request.form["topic"]}])
    return jsonify({"text": resp["content"]})

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 8080)))
```

---

## 五、硬性约束与交付自检（违反 = 审核不过或运行报错；交付前逐条勾）

**manifest 与能力声明**

- [ ] manifest 各字段齐备；`capabilities` / `network` / `runtime` / `env` 与代码实际行为**严格一致**（审批照单，改白名单 = 重新提审；宁少勿多，不声明的能力调用直接报错）
- [ ] 外部配置项已声明 manifest `env`（§1.1）：必填/可选、secret、pattern 划分正确，代码经 `os.environ` 读取，未声明平台保留变量名
- [ ] 没有硬编码任何密钥/令牌；没有绕过平台向使用者索要密钥（前端输入框收 key = 设计错误）

**代码边界**

- [ ] Python 包单文件 `mod.py`（persistent 可带静态资源目录）；只用标准库 + 平台预置框架 + manifest `requirements` 声明的依赖（§1.2，上传时自动安装），无运行时自装
- [ ] 无自建网络出口（无 socket / os.system / 子进程）：出站只经 `aap.http.fetch`，域名全部在 manifest `network` 里，上游状态码 `resp["status"]` 逐分支处理
- [ ] invoked 出入参可 JSON 序列化（二进制存 storage 给链接）；长任务拆分或加进度说明（invoked 有超时）
- [ ] 错误路径友好：失败返回 `{"error": "人类可读的中文说明"}`

**运行时状态**

- [ ] invoked 无状态：跨请求状态一律落 `aap.db` / `aap.storage`
- [ ] persistent 状态纪律：任务/结果/草稿/每用户配置落 `aap.db`，不依赖进程内存（空闲回收约 5 分钟，§二）
- [ ] persistent：`PORT` 环境变量 + `127.0.0.1` 监听 + 相对路径 / `X-Forwarded-Prefix`（§二）
- [ ] 按门户用户隔离数据时行键自带 user_key（persistent 从 `x-aap-identity` 头解码并用 `AAP_SIGN_SECRET` 验签；invoked 看 input 调用者字段）

**日志（§3.5）**

- [ ] 只用 `aap.log` / 标准 logging，没有 `print()`；级别语义正确、敏感信息脱敏、高频循环聚合不逐条 DEBUG；环境变量值不打进日志

**前端（HTML 工具与 persistent 页面通用，§3.7）**

- [ ] 无 localStorage / sessionStorage / cookie 依赖；无密钥收集；剪贴板带 `execCommand('copy')` 降级；资源与接口全部相对路径
- [ ] persistent：右上角留白（建议 220×48px）不遮挡门户按钮；没有自建登录/登出入口（§3.6）

**交付**

- [ ] 已在本地 aap-dev 跑通（当前支持 invoked：`run` + mock LLM，见 §七；persistent 待 serve 上线，先以上传后试运行验证）

## 六、交付与上架流程

```
本地调试沙箱自测（§七 aap-dev：跑通 invoked、看详细日志）
   ↓  打包 ZIP（manifest.json + mod.py[/index.html]）
   ↓  上传门户 → 自动校验（manifest 完整性 / 语法检查）
   ↓  默认「私有」：上传者自己可见可用 ←— 上传后先试运行！运行记录里看日志
   ↓  「提交审核」→ 管理员看代码 + 试运行（日志同样收口可见）
   ↓  通过 → 「公开」：门户所有用户可用
       （驳回会带理由，改完重新提审；版本更新视为新审核）
```

给用户交付时：提供 ZIP 包 + 一段「如何自测」说明（本地 aap-dev 自测 → 上传 → 私有可见 → 试运行 → 提审）。

## 七、本地调试沙箱（aap-dev，v0.2 新增）

Python 代码需要调试。平台提供**本地调试沙箱**：它与你上传后的线上运行**共用同一套 SDK 与执行器**，行为完全一致；唯一差异是调试模式下详细日志全开。**先在本地跑通，再上传。**

```bash
# 当前实装（invoked：本地执行一次 handle()）
aap-dev run mod.py --input input.json     # --input 缺省读 stdin；--llm 默认 mock（本地回声+夹具）
aap-dev run mod.py --reset                # 顺带清空本地 db/storage（.aap-dev/ 目录）

# 随平台 M4 完整版提供（当前未实装，勿依赖、勿写进交付说明）：
#   serve 子命令（persistent 本地起服务）、--llm real（经平台网关）、--submit（调试日志回传门户运行记录）
```

调试模式（`AAP_DEBUG=1`）下全量打印：

- 每次 `aap.*` 调用：接口名、入参（脱敏后）、出参摘要、耗时
- `aap.db`：实际执行的 SQL 与参数、影响行数
- `aap.storage`：每个文件操作与配额水位
- `aap.http.fetch`：URL、**白名单判定结果**、上游状态码、耗时
- `aap.llm.chat`：模型、token 用量、耗时（mock 模式标注 MOCK）
- 进程生命周期：启动、超时、退出码（invoked）

**与线上行为一致的边界**（刻意为之，别绕）：

- manifest `network` 白名单在本地**照常强制执行**——未声明的域名一样被拒，这才是真实行为
- capabilities 未声明的接口一样直接报错
- invoked 的超时、JSON 校验、进程即毁语义完全相同

---

## 八、实战案例与坑清单

### 8.1 把现有 Web 项目重构为 .neon-aap 的方法论

移植/重构的实质是**逐项替换自建设施为平台能力**，业务逻辑保留：

| 自建设施 | 平台替代 |
|---|---|
| 用户/登录/OIDC/人机验证 | 门户统一账号 + 应用可见性（public/login/restricted/private） |
| LLM 接入（多上游/key/计费） | `aap.llm.chat` + passUser 归因（按浏览用户扣费，余额预检 402） |
| 密钥/配置保管 | manifest `env`（§1.1）+ 门户环境变量 |
| 中心数据库 | `aap.db`（行键带 user_key 隔离各用户） |
| 审计/运行记录 | 平台运行记录 + audit_logs（自动） |
| 出站 API 调用 | `aap.http.fetch` + manifest `network` 白名单 |

**案例 A · ip-analyzer**（Flask+AbuseIPDB → persistent 包，`examples/ip-analyzer/`）：
五个替换——requests→`aap.http.fetch`（鉴权头）、密钥 UI 收集→`env` 注入、socket 反查删除、
localStorage 清除、任务状态落 `aap.db`。

**案例 B · llm-proofread**（React19+Express+tRPC+MySQL → 全新 persistent 包）：
自建用户系统、LLM 多上游接入、密钥保管、审计日志**整体删除**；包内只剩校对编排、
规则引擎、diff 呈现、每用户提示词/词库（aap.db）。完整设计见仓库内
`ai-app-portal-docs/llm-proofread-aap-design.md`（平台仓库参考，门户用户可忽略）。

### 8.2 坑清单（全部实测踩过；只列带独立诊断症状的条目，规则本体见 §二 / §3.x / §五）

| 坑 | 症状 | 正确做法 |
|---|---|---|
| persistent 进程内存放任务/结果 | 空闲回收（默认约 5 分钟）后「任务不存在」 | 状态落 `aap.db`（§二 状态纪律） |
| `socket` / 直连网络 | 平台网络守卫报错，且违反规范 | `aap.http.fetch`（headers 带鉴权头，§3.4） |
| 忽略 `resp["status"]` | 上游 401/429 被当成功处理 | fetch 返回上游状态码，逐分支处理 |
| persistent 响应 Set-Cookie | 被门户剥离（防 cookie tossing），浏览器拿不到 | 会话态落 `aap.db` + 身份头，不依赖 Cookie |
| `print()` 调试 | invoked 下污染 JSON 出参协议；日志丢失 | `logging`（"aap.*" logger）/ `aap.log`（§3.5） |

---

*本规范由 ai-app-portal 平台维护；接口面（§三）变更必须升版本并同步 `app-develop-internal.skill.md` 的平台实现约定。*

# app-develop.skill.md

> AI应用门户（ai-app-portal）应用开发规范 · 供开发 Agent 使用
> 版本 v0.2.2（2026-09）· 配套平台 PRD v0.3+
>
> **v0.2.2 变更**：manifest 新增 `env` 字段（§1.1 环境变量 / 机密声明）——需要 API key 等配置的包不再硬编码，改为 manifest 声明变量名（必填/可选、是否密钥、格式校验、默认值），上传后由归属者/管理员在门户填值（密钥 AES-256-GCM 加密存储、界面只写不读），沙箱启动时自动注入为进程环境变量（`os.environ` 直接读）。§3.4 `aap.http.fetch` 支持 `headers` 自定义请求头并透传上游状态码（鉴权 API 场景）。§五 硬性约束与 §七 自检清单同步。
>
> **v0.2.1 状态标注**：HTML 包门户托管已上线（上传即托管生效）；Python 沙箱运行时（invoked / persistent）已实装。统一页面元素（§3.6）与 LLM 自动签发已实装：manifest 声明 `llm` 能力的包，上传即自动配置网关凭据，无需任何手动操作。
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
  "entry": "mod.py",                 // python 必填；html 固定 index.html
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
- **路径前缀注意事项**（重要，最容易踩的坑）：
  - 你的应用挂在 `/app/<route>/` 之下，不是根路径
  - 页面里所有静态资源用**相对路径**（`./static/x.css`），不要写 `/static/x.css`
  - 支持 `X-Forwarded-Prefix` 请求头：用它拼绝对路径更稳
  - Cookie 需设置 `Path=/app/<route>/`
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

## 五、硬性约束（违反 = 审核不过或运行报错）

1. **单文件**：Python 包只有一个 `mod.py`（外加 persistent 可选的静态资源目录）。
2. **依赖白名单**：只能用 Python 标准库 + 平台预置框架（标准库全量、flask 等 Web 框架）。**不能 pip install**。
3. **无网络通道**（除 `aap.http.fetch` + 白名单）：没有 socket、没有 os.system、没有子进程。
4. **JSON 进出**：invoked 的入参出参必须是可 JSON 序列化结构；不要返回二进制（存 storage 给链接）。
5. **无状态纪律**（invoked）：进程即抛，跨请求状态一律落 `aap.db` / `aap.storage`。
6. **路径前缀纪律**（persistent）：相对路径 / `X-Forwarded-Prefix`，见第二节。
7. **密钥零持有**：LLM/DB/存储全部平台托管，**任何情况下不要在代码/manifest 里写 API key**——平台自动剥除并标红审核。
8. **用户数据边界**：`db`/`storage` 按包隔离；如需按「门户用户」隔离数据，键名自行带用户标识（persistent 下平台注入请求头含用户身份，invoked 下 input 里有调用者字段）。
9. **日志纪律**（v0.2）：只用 `aap.log`/标准 logging，**禁 `print()`**；级别语义按 §3.5；脱敏与限量是硬要求，审核会抽查运行记录。
10. **统一元素纪律**（v0.2）：persistent 应用不得遮挡门户注入的「返回个人中心/退出登录」按钮，不得自建登录/登出入口（§3.6）。
11. **配置纪律**（v0.2.2）：外部配置（第三方 API key、阈值等）一律走 manifest `env` 声明 + 门户「环境变量」填值注入（§1.1）；不得硬编码密钥（见第 7 条），不得绕过平台向使用者索要密钥，不得声明平台保留变量名。

## 六、交付与上架流程

```
本地调试沙箱自测（§八 aap-dev：跑通 invoked/persistent、看详细日志）
   ↓  打包 ZIP（manifest.json + mod.py[/index.html]）
   ↓  上传门户 → 自动校验（manifest 完整性 / 语法检查）
   ↓  默认「私有」：上传者自己可见可用 ←— 上传后先试运行！运行记录里看日志
   ↓  「提交审核」→ 管理员看代码 + 试运行（日志同样收口可见）
   ↓  通过 → 「公开」：门户所有用户可用
       （驳回会带理由，改完重新提审；版本更新视为新审核）
```

给用户交付时：提供 ZIP 包 + 一段「如何自测」说明（本地 aap-dev 自测 → 上传 → 私有可见 → 试运行 → 提审）。

## 七、开发 Agent 自检清单（交付前逐条过）

- [ ] manifest 各字段齐备，capabilities/network/runtime 与代码实际行为**严格一致**
- [ ] invoked：`handle(input, aap)` 签名正确，出入可 JSON 序列化
- [ ] persistent：`PORT` 环境变量 + `127.0.0.1` 监听 + 相对路径/前缀处理
- [ ] 只用了标准库 + 预置框架；没有任何 pip 依赖
- [ ] 没有自建网络出口；fetch 的域名全部在 manifest `network` 里
- [ ] 没有硬编码任何密钥/令牌
- [ ] **需要外部配置的项已声明在 manifest `env`（§1.1）：必填/可选、是否密钥、格式校验划分正确；代码经 `os.environ` 读取；没有把值打进日志**
- [ ] **日志全部走 `aap.log`/logging，没有 `print()`；级别使用符合 §3.5 语义；敏感信息已脱敏；高频循环没有逐条 DEBUG**
- [ ] **persistent：右上角已留白，未遮挡门户统一按钮；没有自建登录/登出入口**
- [ ] 长任务拆分或加进度说明（invoked 有超时）
- [ ] 错误路径友好：失败返回 `{"error": "人类可读的中文说明"}`
- [ ] 已在本地调试沙箱（aap-dev）完整跑通并核对详细日志

## 八、本地调试沙箱（aap-dev，v0.2 新增）

Python 代码需要调试。平台提供**本地调试沙箱**：它与你上传后的线上运行**共用同一套 SDK 与执行器**，行为完全一致；唯一差异是调试模式下详细日志全开。**先在本地跑通，再上传。**

```bash
# invoked：本地执行一次 handle()
aap-dev run mod.py --manifest manifest.json --input input.json

# persistent：本地起服务（同样注入 PORT、AAP_DEBUG，默认 127.0.0.1:8080）
aap-dev serve mod.py --manifest manifest.json

# 常用参数
#   --reset                 清空本地 db/storage（.aap-dev/ 目录）
#   --llm mock|real         LLM 走本地 mock（默认，回声+夹具）或真实网关（需 --llm-endpoint/--llm-token）
#   --submit                把本次调试日志回传门户运行记录（可选，需已配置门户地址与凭据）
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

*本规范由 ai-app-portal 平台维护；接口面（§三）变更必须升版本并同步 `app-develop-internal.skill.md` 的平台实现约定。*

# app-develop.skill.md

> AI应用门户（ai-app-portal）应用开发规范 · 供开发 Agent 使用
> 版本 v0.1 草案（2026-09）· 配套平台 PRD v0.3+

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
  "route": "stock-summary"           // 仅 persistent：门户内的路由前缀 /app/stock-summary/
}
```

**铁律**：
1. `capabilities` 和 `network` 是**审批依据**——写了什么，管理员就按什么审；上线后想改白名单 = 重新提审。
2. 不声明的能力**调用会直接报错**。宁少勿多，按需申请。
3. `runtime: "persistent"` 会常驻占用资源，审查更严：没有持续服务需求的（哪怕要调 LLM）一律用 `invoked`。

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
# resp: {"status": 200, "body": ...}
```

- 域名必须**逐条写在 manifest `network`**，未声明域名直接被代理拒绝
- 执行点在平台代理侧，代码里无法绕过（也没有 socket / os.system 可用）
- 无需自己处理 TLS/代理细节，fetch 直给结果

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

    resp = aap.llm.chat(
        messages=[
            {"role": "system", "content": "你是财务摘要助手，输出 JSON"},
            {"role": "user", "content": f"股票 {code}，备注 {text}，生成三句话摘要"},
        ],
        max_tokens=800,
    )

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
    # 注意：相对路径；前缀由平台注入
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

## 六、交付与上架流程

```
打包 ZIP（manifest.json + mod.py[/index.html]）
   ↓  上传门户 → 自动校验（manifest 完整性 / 语法检查）
   ↓  默认「私有」：上传者自己可见可用 ←— 先自测！
   ↓  「提交审核」→ 管理员看代码 + 试运行
   ↓  通过 → 「公开」：门户所有用户可用
       （驳回会带理由，改完重新提审；版本更新视为新审核）
```

给用户交付时：提供 ZIP 包 + 一段「如何自测」说明（上传 → 私有可见 → 试运行 → 提审）。

## 七、开发 Agent 自检清单（交付前逐条过）

- [ ] manifest 各字段齐备，capabilities/network/runtime 与代码实际行为**严格一致**
- [ ] invoked：`handle(input, aap)` 签名正确，出入可 JSON 序列化
- [ ] persistent：`PORT` 环境变量 + `127.0.0.1` 监听 + 相对路径/前缀处理
- [ ] 只用了标准库 + 预置框架；没有任何 pip 依赖
- [ ] 没有自建网络出口；fetch 的域名全部在 manifest `network` 里
- [ ] 没有硬编码任何密钥/令牌
- [ ] 长任务拆分或加进度说明（invoked 有超时）
- [ ] 错误路径友好：失败返回 `{"error": "人类可读的中文说明"}`

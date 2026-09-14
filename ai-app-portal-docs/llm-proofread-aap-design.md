# llm-proofread（文语校对）· AAP 重构设计

> **状态（2026-09-15）**：MVP 已实现（`examples/llm-proofread/`，v0.1.0）——段落切分、规则引擎、
> 逐段 LLM（并发 3）、一致性检查、Inline Diff、逐段接受/忽略、每用户提示词与词库（aap.db）、
> 任务落库跨重启。二期：固定表述参考库、校对历史页、用量统计；三期：开放 API（等平台）。
>
> 结论先行：文语校对是「长文本 + LLM + 每用户自有配置」形态的应用，与 AAP 平台能力**天然契合**——
> 原项目里最重的四块（用户系统、LLM 多上游接入、密钥保管、MySQL/审计）在 AAP 上**全部不用写**，
> 包本体只剩「校对编排 + 规则引擎 + diff 呈现」。本设计不移植原代码，只映射功能。
>
> 配套：app-develop.skill-v0.2.md（v0.2.3）· 平台 G2/G5/G6 已实装能力。

## 一、能力映射：原实现 → AAP

| 原项目模块 | 原实现 | AAP 方案 | 工作量 |
|---|---|---|---|
| 用户/登录/OIDC/Turnstile/强制改密 | React+Express+JWT+bcrypt | **删**。门户统一账号 + 会话；可见性用 `visibility`（建议 `login`） | 0 |
| LLM 多上游（Base URL/Key/模型/并发） | 用户自填 key、平台代管 | **删**。`aap.llm.chat` 走统一 LLM 网关；管理员在管理后台配上游与模型目录；**包与用户零密钥** | 0 |
| LLM 计费与配额 | 无（用户自己的 key） | **免费获得**。passUser 归因：每次校对计入**发起用户**的额度池，余额不足 402 | 0 |
| 审计日志 | txt 文件挂载目录 + 清理 | **免费获得**。平台运行记录 + audit_logs；校对历史落 `aap.db` | 0 |
| MySQL/Drizzle | 中心库 | `aap.db`（每包独立 SQLite），按 `user_key` 隔离各用户数据 | 换 SQL 方言 |
| 校对提示词 / 一致性提示词（每用户） | 库表 | `aap.db` 表，`user_key` 键控；未设置用内置默认提示词 | 保留 |
| 违禁词 / 替换规则 / 固定表述库 | 库表 + 管理 UI | `aap.db` 同构三张表；固定表述库由应用归属者维护（`user_key='__global__'`），普通用户只管个人词库与提示词 | 保留 |
| 规则引擎（违禁词命中/替换建议） | 服务端 | 照写（纯字符串处理，标准库）；无 LLM 成本 | 保留 |
| 段落切分 + 逐段 LLM 校对（并行） | 服务端 | persistent 包内线程池（并发 3–4，`max_tokens` 显式设，控额度消耗） | 保留 |
| 全文一致性检查（单独一次 LLM） | 服务端 | 同上，与段落校对并行提交 | 保留 |
| Inline Diff 呈现 / 逐段接受忽略 | 前端 | 前端照搬交互（diff 算法在前端，标准库产出「原文/修改后」对即可） | 保留 |
| 校对历史 | txt 文件 | `aap.db` 历史表（原文摘要+结果 JSON+用量），按 user_key 隔离；原文全文可选落 `aap.storage` | 轻量重做 |
| iframe 嵌入 / 开放 API（pk_xxx token） | 自建 | 暂不做。对应平台能力 = 应用可见性 + 沙箱 iframe 本身；开放 API 等 AAP 开放体系（M4+） | 缓 |

## 二、包形态与 manifest

```jsonc
{
  "name": "llm-proofread",
  "display_name": "文语校对",
  "type": "python",
  "entry": "mod.py",
  "runtime": "persistent",            // Web UI + 进度轮询 + 并行 LLM，必须 persistent
  "route": "llm-proofread",
  "capabilities": ["llm", "db"],      // llm=自动签发网关凭据；db=提示词/词库/历史
  "network": [],                      // 出站为零：LLM 走平台网关，不需要任何域名
  "passUser 建议": true                // 上传时勾选：LLM 消耗按浏览用户归因计费
}
```

**没有任何 env 机密**——原项目要求每个用户填 API Key，在 AAP 上这是网关的事。
这是本重构最大的卖点：接入成本从「注册各家 LLM、管 key、管余额」降为零。

## 三、数据模型（aap.db，全部带 user_key）

```sql
CREATE TABLE IF NOT EXISTS settings (          -- 每用户配置（提示词等）
  user_key TEXT, name TEXT, value TEXT,
  PRIMARY KEY (user_key, name)
);                                             -- name: proofread_prompt / coherence_prompt / concurrency
CREATE TABLE IF NOT EXISTS banned_words (      -- 违禁词：__global__ 归属者维护 + 个人补充
  user_key TEXT, word TEXT, PRIMARY KEY (user_key, word)
);
CREATE TABLE IF NOT EXISTS replace_rules (     -- 替换规则：键值对
  user_key TEXT, k TEXT, v TEXT, PRIMARY KEY (user_key, k)
);
CREATE TABLE IF NOT EXISTS fixed_expressions ( -- 固定表述参考库（归属者 __global__）
  user_key TEXT, term TEXT, standard TEXT, PRIMARY KEY (user_key, term)
);
CREATE TABLE IF NOT EXISTS jobs (              -- 校对任务：状态落库（ip-analyzer 教训）
  job_id TEXT PRIMARY KEY, user_key TEXT, status TEXT,
  total INTEGER, done INTEGER, result_json TEXT,
  usage_json TEXT, created_at TEXT, finished_at TEXT
);
```

`user_key` 来源（persistent + passUser）：网关给每个代理请求注入 `x-aap-identity`（签名）+
`x-aap-identity-sig` 头。mod.py 解码 payload JSON 取稳定标识（`sub`）作为 user_key；
签名校验由网关注入链保证（外部无法伪造该头，REQ_SKIP 剥离外来同名头）。
→ 平台改进项：SDK 提供 `aap.identity`（已解码+验签的当前用户），省去每个包自己解码。

## 四、校对流程

```
浏览器（粘贴文本、开关：规则/LLM/固定表述/一致性）
  │ POST ./jobs  {text, use_llm, use_rules, use_fixed, use_coherence}
  ▼
mod.py：取 user_key → 读该用户提示词（缺省内置）→ 建任务行(status=pending)
  → 起线程组：
     ├─ 规则引擎（违禁词扫描 + 替换建议）：纯本地，逐段
     ├─ 段落 LLM 校对 × N 段：线程池并发 3，aap.llm.chat(identity=当前用户)
     │   system = 该用户 proofread_prompt（+固定表述库若开启）
     └─ 一致性检查 × 1：全文一次，该用户 coherence_prompt
  ▼
前端轮询 GET ./jobs/<id>（进度）→ 完成后取 result_json
  → 前端渲染逐段 inline diff（绿增红删）→ 逐段接受/忽略 → 一键复制
```

要点：
- **并发上限**在包内（线程池 3–4），`max_tokens` 显式设置——长文容易一次烧掉用户大量额度，
  预检 402 会逐段触发，包要捕获并把「额度不足」作为可读错误返回
- **usage 透传**：`resp["usage"]` 累计进任务行，前端展示「本次消耗 xx token」——用户对花销有感知
- LLM 输出 JSON 化（修改后段落 + 修改说明），解析失败降级为「原文原样 + 说明=解析失败」，
  不让单段失败拖垮整篇

## 五、分期

1. **MVP**：粘贴 → 段落切分 → 规则 + 段落 LLM + 一致性 → diff 呈现 → 接受/忽略/复制。
   每用户仅两项配置：校对提示词、一致性提示词。
2. **二期**：违禁词/替换规则/固定表述库管理 UI；校对历史与重看；用量统计页。
3. **三期（依赖平台）**：匿名嵌入（对应原 iframe embed）、开放 API（对应 pk_xxx）——
   等 AAP 开放体系，先用「可见性=指定分组」给小范围人群用。

## 六、与原项目的取舍说明

- 原项目的多用户体系在 AAP 由门户承担，**应用内不再有「管理员/用户」两层**——
  原管理员职能（固定表述库、全局词库）收敛给应用归属者；普通用户的私有配置天然隔离
- 原项目的「兼容任意 OpenAI 兼容接口」在 AAP 上不需要：模型目录由平台管理员统一治理，
  用户选模型 = 从平台目录里选名字（二期可加 `aap.llm` 模型列表查询）
- 内容合规责任：校对对象的文本经用户粘贴进入，历史落 aap.db 受平台配额约束；
  若需内容审计，平台 audit_logs 已覆盖「谁在何时用了多少」，文本内容审计按需加开关

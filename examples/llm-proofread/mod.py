"""
文语校对（llm-proofread）· .neon-aap Python 包（persistent）
================================================================
按 `ai-app-portal-docs/llm-proofread-aap-design.md` 实现（AAP 重构版，不移植原项目代码）：

- 用户/登录/密钥/计费全部由平台承担：本包零 env 机密、零出站（network 空），
  LLM 走统一网关（aap.llm.chat），消耗按 passUser 归因计入发起用户额度池。
- 每用户数据（校对/一致性提示词、违禁词、替换规则、校对历史）按 user_key = kind:uid
  隔离存于 aap.db（身份来自网关注入的 x-aap-identity 头，外部不可伪造）。
- 任务与进度落 aap.db（persistent 状态纪律：进程会被空闲回收/重启）。
- LLM 输出严格 JSON，解析失败单段降级不拖垮整篇。
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

from flask import Flask, jsonify, request, send_file

logger = logging.getLogger("aap.llm_proofread")

PKG_DIR = os.environ.get("AAP_PACKAGE_DIR") or os.path.dirname(os.path.abspath(__file__))

MAX_TOTAL_CHARS = 30_000
MAX_PARAGRAPHS = 60
MAX_PARA_CHARS = 1_500
MAX_COHERENCE_CHARS = 8_000
LLM_CONCURRENCY = 3
PARA_MAX_TOKENS = 1_500
COHERENCE_MAX_TOKENS = 1_200

DEFAULT_PROOFREAD_PROMPT = (
    "你是严谨的中文文本校对助手。只修正错别字、标点误用、明显语病与事实性表述错误，"
    "保持原意、语气与行文风格，不重写、不增删内容。输出严格 JSON："
    '{"corrected": "修改后的整段文本", "notes": ["修改点说明，每条一句话"]}. '
    "若无修改，corrected 与原文一致，notes 为空数组。不要输出 JSON 以外的任何内容。"
)
DEFAULT_COHERENCE_PROMPT = (
    "你是长文本一致性审校员。通读全文，从事件逻辑、人物与主体线索、时间空间连贯性、"
    "数据细节一致性四个维度检查。输出严格 JSON："
    '{"score": 1到10的整数, "issues": ["问题描述（引用原文短语）"], "suggestion": "总体建议一句话"}. '
    "无问题则 issues 为空数组。不要输出 JSON 以外的任何内容。"
)

DB_LOCK = threading.Lock()

app = Flask(__name__)


# ---------- 身份（persistent + passUser：网关逐请求注入签名身份头） ----------

def get_identity() -> tuple[str, str] | None:
    """返回 (payload, sig) 供 aap.llm.chat 归因（必须在工作线程外捕获请求头）。"""
    p = request.headers.get("x-aap-identity", "")
    s = request.headers.get("x-aap-identity-sig", "")
    return (p, s) if p and s else None


def get_user_key() -> str:
    """user_key = kind:uid（平台身份契约：按 (kind, uid) 隔离账号数据）。
    无身份头（passUser 未开启/匿名）时落 shared 空间，前端会提示。"""
    p = request.headers.get("x-aap-identity", "")
    if p:
        try:
            pad = "=" * (-len(p) % 4)
            payload = json.loads(base64.urlsafe_b64decode(p + pad))
            return f"{payload.get('kind', 'user')}:{payload.get('uid', '?')}"
        except Exception as err:  # noqa: BLE001
            logger.warning("身份解码失败: %s", err)
    return "shared"


def current_name() -> str:
    p = request.headers.get("x-aap-identity", "")
    if p:
        try:
            pad = "=" * (-len(p) % 4)
            return json.loads(base64.urlsafe_b64decode(p + pad)).get("name") or "用户"
        except Exception:  # noqa: BLE001
            pass
    return "访客"


# ---------- aap.db 访问（单连接跨线程共享，全部经锁串行化） ----------

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS settings (
        user_key TEXT, name TEXT, value TEXT,
        PRIMARY KEY (user_key, name)
    )""",
    """CREATE TABLE IF NOT EXISTS banned_words (
        user_key TEXT, word TEXT, created_at TEXT,
        PRIMARY KEY (user_key, word)
    )""",
    """CREATE TABLE IF NOT EXISTS replace_rules (
        user_key TEXT, k TEXT, v TEXT, created_at TEXT,
        PRIMARY KEY (user_key, k)
    )""",
    """CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        user_key TEXT,
        status TEXT,
        total INTEGER,
        done INTEGER,
        error TEXT,
        result_json TEXT,
        usage_json TEXT,
        created_at TEXT,
        finished_at TEXT
    )""",
]


def ensure_schema() -> None:
    with DB_LOCK:
        for ddl in SCHEMA:
            aap.db.execute(ddl)  # noqa: F821 — runner 注入


def db_exec(sql: str, params: tuple = ()) -> int:
    with DB_LOCK:
        return aap.db.execute(sql, params)  # noqa: F821


def db_query(sql: str, params: tuple = ()) -> list[dict]:
    with DB_LOCK:
        return aap.db.query(sql, params)  # noqa: F821


# ---------- 每用户配置 ----------

def get_setting(user_key: str, name: str, default: str) -> str:
    rows = db_query("SELECT value FROM settings WHERE user_key = ? AND name = ?", (user_key, name))
    return rows[0]["value"] if rows and rows[0]["value"] else default


def put_setting(user_key: str, name: str, value: str) -> None:
    db_exec(
        "INSERT INTO settings (user_key, name, value) VALUES (?, ?, ?) "
        "ON CONFLICT (user_key, name) DO UPDATE SET value = excluded.value",
        (user_key, name, value),
    )


# ---------- 规则引擎（零 LLM 成本） ----------

def run_rules(text: str, user_key: str) -> dict:
    """违禁词命中 + 替换建议。返回 {hits: [...], suggestions: [...], replaced: str}"""
    hits: list[dict] = []
    for row in db_query("SELECT word FROM banned_words WHERE user_key = ?", (user_key,)):
        word = row["word"]
        start = 0
        while True:
            idx = text.find(word, start)
            if idx < 0:
                break
            hits.append({"word": word, "pos": idx})
            start = idx + len(word)
    suggestions: list[dict] = []
    replaced = text
    for row in db_query("SELECT k, v FROM replace_rules WHERE user_key = ?", (user_key,)):
        k, v = row["k"], row["v"]
        if k and k in text:
            suggestions.append({"from": k, "to": v, "count": text.count(k)})
            replaced = replaced.replace(k, v)
    return {"hits": hits, "suggestions": suggestions, "replaced": replaced}


# ---------- LLM ----------

def extract_json(text: str) -> dict | None:
    """宽松提取 LLM 输出中的 JSON 对象（容忍 markdown 围栏与前后缀话）。"""
    if not text:
        return None
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        obj = json.loads(text[start : end + 1])
        return obj if isinstance(obj, dict) else None
    except ValueError:
        return None


def llm_json(system: str, user_content: str, identity, max_tokens: int) -> dict:
    """调用 LLM 并解析 JSON。返回 {"ok": True, "data": ...} 或 {"ok": False, "error": ...}。
    identity 必须显式传入：工作线程没有 flask 请求上下文，runner 无法自动取头。"""
    try:
        resp = aap.llm.chat(  # noqa: F821 — runner 注入
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user_content},
            ],
            max_tokens=max_tokens,
            identity=identity,
        )
    except Exception as err:  # noqa: BLE001
        msg = str(err)
        if "403" in msg or "AUTH" in msg.upper():
            msg += "（提示：LLM 归因失败——请确认应用上传时已开启 passUser 身份注入，且门户 LLM 网关已配置可用上游）"
        return {"ok": False, "error": msg[:300]}
    usage = resp.get("usage") or {}
    data = extract_json(resp.get("content", ""))
    if data is None:
        return {"ok": False, "error": "模型输出不是合法 JSON（可在设置中调整提示词，强调只输出 JSON）", "usage": usage}
    return {"ok": True, "data": data, "usage": usage}


def usage_add(total: dict, usage: dict) -> None:
    total["prompt_tokens"] = total.get("prompt_tokens", 0) + int(usage.get("prompt_tokens") or 0)
    total["completion_tokens"] = total.get("completion_tokens", 0) + int(usage.get("completion_tokens") or 0)


# ---------- 任务编排 ----------

def proofread_job(job_id: str, user_key: str, identity, text: str, opts: dict) -> None:
    """单编排线程：规则引擎即时完成；段落 LLM 线程池并发；一致性检查并行。
    全程落库，进程被回收后进度与结果不丢（persistent 状态纪律）。"""
    usage_total: dict = {}
    result: dict = {"paragraphs": [], "coherence": None, "usage": usage_total}
    try:
        paragraphs = [ln for ln in (s.strip() for s in text.split("\n")) if ln]
        db_exec("UPDATE jobs SET status = 'running', total = ?, done = 0 WHERE job_id = ?", (len(paragraphs), job_id))
        # 槽位先建全（含原文）：规则/LLM 各自回填，渲染端永远拿得到原文基准
        result["paragraphs"] = [
            {"idx": i, "original": para, "rule": None, "llm": None, "truncated": False}
            for i, para in enumerate(paragraphs)
        ]

        # 规则引擎（即时，零成本）
        if opts.get("use_rules"):
            for slot in result["paragraphs"]:
                slot["rule"] = run_rules(slot["original"], user_key)

        # 段落 LLM 校对（并发）
        if opts.get("use_llm"):
            proofread_prompt = get_setting(user_key, "proofread_prompt", DEFAULT_PROOFREAD_PROMPT)
            para_results: dict = {}

            def one(i: int, para: str) -> tuple[int, dict, dict]:
                truncated = len(para) > MAX_PARA_CHARS
                content = para[:MAX_PARA_CHARS] + ("…[超长截断]" if truncated else "")
                r = llm_json(proofread_prompt, f"校对以下段落：\n{content}", identity, PARA_MAX_TOKENS)
                return i, r, {"truncated": truncated}

            with ThreadPoolExecutor(max_workers=LLM_CONCURRENCY) as pool:
                futures = [pool.submit(one, i, p) for i, p in enumerate(paragraphs)]
                done_count = 0
                for fut in as_completed(futures):
                    i, r, meta = fut.result()
                    entry: dict = {}
                    if r.get("ok"):
                        entry["corrected"] = str(r["data"].get("corrected", ""))
                        entry["notes"] = r["data"].get("notes") if isinstance(r["data"].get("notes"), list) else []
                    else:
                        entry["error"] = r.get("error", "校对失败")
                    usage_add(usage_total, r.get("usage") or {})
                    para_results[i] = {"entry": entry, "truncated": meta.get("truncated", False)}
                    done_count += 1
                    db_exec("UPDATE jobs SET done = ? WHERE job_id = ?", (done_count, job_id))
            for i, pr in para_results.items():
                slot = result["paragraphs"][i]
                slot["llm"] = pr["entry"]
                slot["truncated"] = pr["truncated"]

        # 全文一致性检查（单次，与段落校对串行收尾——并行已在段落池内体现）
        if opts.get("use_coherence"):
            coherence_prompt = get_setting(user_key, "coherence_prompt", DEFAULT_COHERENCE_PROMPT)
            full = text if len(text) <= MAX_COHERENCE_CHARS else text[:MAX_COHERENCE_CHARS] + "…[超长截断]"
            r = llm_json(coherence_prompt, f"通读校验以下全文：\n{full}", identity, COHERENCE_MAX_TOKENS)
            usage_add(usage_total, r.get("usage") or {})
            if r.get("ok"):
                result["coherence"] = {
                    "score": r["data"].get("score"),
                    "issues": r["data"].get("issues") if isinstance(r["data"].get("issues"), list) else [],
                    "suggestion": str(r["data"].get("suggestion", "")),
                }
            else:
                result["coherence"] = {"error": r.get("error", "一致性检查失败")}

        db_exec(
            "UPDATE jobs SET status = 'completed', result_json = ?, usage_json = ?, finished_at = ? WHERE job_id = ?",
            (json.dumps(result, ensure_ascii=False), json.dumps(usage_total), datetime.now().isoformat(), job_id),
        )
        logger.info("校对完成 job=%s paras=%d tokens=%s", job_id[:8], len(paragraphs), usage_total)
    except Exception as err:  # noqa: BLE001
        logger.error("校对任务失败 job=%s err=%s", job_id[:8], err)
        db_exec("UPDATE jobs SET status = 'error', error = ?, finished_at = ? WHERE job_id = ?",
                (str(err)[:500], datetime.now().isoformat(), job_id))


# ---------- 页面 ----------

@app.route("/")
def index():
    return send_file(os.path.join(PKG_DIR, "web", "index.html"))


# ---------- 校对任务 API ----------

@app.route("/jobs", methods=["POST"])
def create_job():
    data = request.get_json(silent=True) or {}
    text = str(data.get("text", "")).strip("\n")
    opts = {
        "use_llm": bool(data.get("use_llm", True)),
        "use_rules": bool(data.get("use_rules", True)),
        "use_coherence": bool(data.get("use_coherence", True)),
    }
    if not text.strip():
        return jsonify({"error": "请粘贴需要校对的文本"}), 400
    if len(text) > MAX_TOTAL_CHARS:
        return jsonify({"error": f"文本过长（{len(text)} 字符，上限 {MAX_TOTAL_CHARS}）"}), 400
    paragraphs = [ln for ln in (s.strip() for s in text.split("\n")) if ln]
    if len(paragraphs) > MAX_PARAGRAPHS:
        return jsonify({"error": f"段落数过多（{len(paragraphs)} 段，上限 {MAX_PARAGRAPHS}，可按空行合并）"}), 400

    user_key = get_user_key()
    identity = get_identity()
    job_id = datetime.now().strftime("%Y%m%d%H%M%S") + "-" + os.urandom(4).hex()
    ensure_schema()
    db_exec(
        "INSERT INTO jobs (job_id, user_key, status, total, done, created_at) VALUES (?, ?, 'pending', ?, 0, ?)",
        (job_id, user_key, len(paragraphs), datetime.now().isoformat()),
    )
    threading.Thread(target=proofread_job, args=(job_id, user_key, identity, text, opts), daemon=True).start()
    logger.info("校对任务创建 job=%s user=%s paras=%d opts=%s", job_id[:8], user_key, len(paragraphs), opts)
    return jsonify({"job_id": job_id, "total": len(paragraphs)})


@app.route("/jobs/<job_id>")
def job_status(job_id):
    rows = db_query("SELECT job_id, status, total, done, error, usage_json, created_at, finished_at FROM jobs WHERE job_id = ? AND user_key = ?",
                    (job_id, get_user_key()))
    if not rows:
        return jsonify({"error": "任务不存在"}), 404
    r = rows[0]
    if r["usage_json"]:
        r["usage"] = json.loads(r["usage_json"])
    return jsonify(r)


@app.route("/jobs/<job_id>/result")
def job_result(job_id):
    rows = db_query("SELECT status, result_json, error FROM jobs WHERE job_id = ? AND user_key = ?",
                    (job_id, get_user_key()))
    if not rows:
        return jsonify({"error": "任务不存在"}), 404
    if rows[0]["status"] != "completed":
        return jsonify({"error": "校对未完成"}), 400
    return app.response_class(rows[0]["result_json"] or "{}", mimetype="application/json")


# ---------- 每用户设置 API ----------

@app.route("/settings")
def read_settings():
    user_key = get_user_key()
    return jsonify({
        "name": current_name(),
        "identified": user_key != "shared",
        "proofread_prompt": get_setting(user_key, "proofread_prompt", ""),
        "coherence_prompt": get_setting(user_key, "coherence_prompt", ""),
        "banned_words": [r["word"] for r in db_query("SELECT word FROM banned_words WHERE user_key = ? ORDER BY created_at DESC", (user_key,))],
        "replace_rules": [{"k": r["k"], "v": r["v"]} for r in db_query("SELECT k, v FROM replace_rules WHERE user_key = ? ORDER BY created_at DESC", (user_key,))],
    })


@app.route("/settings", methods=["PUT"])
def update_settings():
    data = request.get_json(silent=True) or {}
    user_key = get_user_key()
    for name in ("proofread_prompt", "coherence_prompt"):
        if name in data:
            value = str(data[name] or "").strip()
            if len(value) > 4000:
                return jsonify({"error": f"{name} 过长（上限 4000 字符）"}), 400
            # 存自定义值；清空 = 恢复内置默认（读取时 default 兜底）
            if value:
                put_setting(user_key, name, value)
            else:
                db_exec("DELETE FROM settings WHERE user_key = ? AND name = ?", (user_key, name))
    return jsonify({"ok": True})


@app.route("/words", methods=["POST"])
def add_word():
    word = str((request.get_json(silent=True) or {}).get("word", "")).strip()
    if not word or len(word) > 100:
        return jsonify({"error": "违禁词为空或过长"}), 400
    db_exec("INSERT OR IGNORE INTO banned_words (user_key, word, created_at) VALUES (?, ?, ?)",
            (get_user_key(), word, datetime.now().isoformat()))
    return jsonify({"ok": True})


@app.route("/words/<word>", methods=["DELETE"])
def del_word(word):
    db_exec("DELETE FROM banned_words WHERE user_key = ? AND word = ?", (get_user_key(), word))
    return jsonify({"ok": True})


@app.route("/rules", methods=["POST"])
def add_rule():
    data = request.get_json(silent=True) or {}
    k, v = str(data.get("k", "")).strip(), str(data.get("v", ""))
    if not k or len(k) > 100 or len(v) > 200:
        return jsonify({"error": "替换规则不合法"}), 400
    db_exec("INSERT INTO replace_rules (user_key, k, v, created_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT (user_key, k) DO UPDATE SET v = excluded.v",
            (get_user_key(), k, v, datetime.now().isoformat()))
    return jsonify({"ok": True})


@app.route("/rules/<path:k>", methods=["DELETE"])
def del_rule(k):
    db_exec("DELETE FROM replace_rules WHERE user_key = ? AND k = ?", (get_user_key(), k))
    return jsonify({"ok": True})


if __name__ == "__main__":
    # runner 以 __main__ 执行本模块：aap 在模块顶层已可见（runner 先行挂载 builtins）。
    # PORT 由平台注入，监听 127.0.0.1 仅经门户反代对外（§二 persistent 纪律）。
    ensure_schema()
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 8080)), threaded=True)

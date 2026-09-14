"""aap_runtime — 平台注入给 .neon-aap python 包的运行时（aap 对象 + runner）。

平台通过 runner.py 启动包进程并注入全局 ``aap``（包内无需 import）：
  - invoked:   stdin 收 JSON 入参 → mod.handle(input, aap) → stdout 回 JSON
  - persistent: runpy 以 __main__ 执行 mod.py（自带 flask 服务，PORT 由环境注入）

能力面（app-develop.skill v0.2 §三，只存在这些接口）：
  aap.llm.chat / aap.db.execute|query / aap.storage.put|get|delete|list
  aap.http.fetch / aap.log.debug|info|warning|error
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import sys
import time
import urllib.request
import urllib.error


def _env(key, default=None):
    return os.environ.get(key, default)


def _resolve_identity(explicit=None):
    """LLM 归因身份（M4 出口标准：调用计入发起用户）。优先级：
    1. 调用方显式传入 (payload, sig)；
    2. persistent 场景：当前 flask 请求上门户代理注入的 x-aap-identity*；
    3. invoked 场景：平台注入的环境变量 AAP_IDENTITY_PAYLOAD/SIG。
    """
    if isinstance(explicit, (tuple, list)) and len(explicit) == 2 and explicit[0] and explicit[1]:
        return explicit[0], explicit[1]
    try:
        from flask import request

        p = request.headers.get("x-aap-identity")
        s = request.headers.get("x-aap-identity-sig")
        if p and s:
            return p, s
    except Exception:
        pass
    p = _env("AAP_IDENTITY_PAYLOAD")
    s = _env("AAP_IDENTITY_SIG")
    if p and s:
        return p, s
    return None


def _platform(path, payload=None, timeout=60, extra_headers=None):
    """平台内部调用（LLM 代理 / 出站代理）。统一携带网关凭据；
    extra_headers 用于回传用户身份头（x-aap-identity*，网关验签归因计费）。"""
    url = _env("AAP_PLATFORM", "http://127.0.0.1:8080").rstrip("/") + path
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="POST" if payload is not None else "GET")
    req.add_header("x-aap-token", _env("AAP_TOKEN", ""))
    if data is not None:
        req.add_header("content-type", "application/json")
    for k, v in (extra_headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:500]
        raise RuntimeError("平台接口错误(%s): %s" % (e.code, body))


def _quota_bytes():
    try:
        return int(_env("AAP_STORAGE_QUOTA", str(10 * 1024 * 1024)))
    except ValueError:
        return 10 * 1024 * 1024


class Llm:
    """LLM 调用（经平台代理 → 网关 → 上游；计入发起用户的额度池）。

    identity：可选 (payload, sig) 身份二元组。persistent 场景由门户代理把
    x-aap-identity* 注入每个请求，模组把它透传到这里即可按浏览用户计费；
    不传时 runner 自动取 flask 请求头（invoked 取平台注入的环境变量）。
    """

    def chat(self, messages, model=None, temperature=None, max_tokens=None, stream=False, identity=None):
        payload = {"messages": messages}
        if model:
            payload["model"] = model
        if temperature is not None:
            payload["temperature"] = temperature
        if max_tokens:
            payload["max_tokens"] = int(max_tokens)
        headers = {}
        ident = _resolve_identity(identity)
        if ident:
            headers["x-aap-identity"] = ident[0]
            headers["x-aap-identity-sig"] = ident[1]
        status, resp = _platform("/api/aap/llm/chat", payload, extra_headers=headers)
        choices = resp.get("choices") or []
        content = ""
        if choices:
            message = choices[0].get("message") or {}
            content = message.get("content", "")
        return {"content": content, "usage": resp.get("usage") or {}, "model": resp.get("model", model or "")}

    # 流式的便捷形式：逐段产出增量文本（底层仍整段返回后切片，行为对齐契约）
    def chat_stream(self, messages, model=None, temperature=None, max_tokens=None, identity=None):
        result = self.chat(messages, model=model, temperature=temperature, max_tokens=max_tokens, identity=identity)
        content = result.get("content", "")
        step = max(1, len(content) // 8)
        for i in range(0, len(content), step):
            yield content[i : i + step]


class Db:
    """每包独立 SQLite；SQL 只作用于本包库，? 占位传参。"""

    def __init__(self, path):
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row

    def execute(self, sql, params=()):
        cur = self._conn.execute(sql, params)
        self._conn.commit()
        return cur.rowcount

    def query(self, sql, params=()):
        return [dict(r) for r in self._conn.execute(sql, params).fetchall()]


class Storage:
    """每包独立配额空间（目录隔离 + 总量限额）。"""

    def __init__(self, root, quota):
        self._root = root
        self._quota = quota
        os.makedirs(root, exist_ok=True)

    def _path(self, key):
        clean = key.lstrip("/").replace("..", "_")
        return os.path.join(self._root, clean)

    def _used(self):
        total = 0
        for root, _dirs, files in os.walk(self._root):
            for f in files:
                total += os.path.getsize(os.path.join(root, f))
        return total

    def put(self, key, data):
        if isinstance(data, str):
            data = data.encode()
        if self._used() + len(data) > self._quota:
            raise RuntimeError("storage 配额已满")
        path = self._path(key)
        os.makedirs(os.path.dirname(path) or self._root, exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        return len(data)

    def get(self, key):
        with open(self._path(key), "rb") as f:
            return f.read()

    def delete(self, key):
        os.remove(self._path(key))

    def list(self, prefix=""):
        base = self._root
        out = []
        for root, _dirs, files in os.walk(base):
            for f in files:
                rel = os.path.relpath(os.path.join(root, f), base).replace(os.sep, "/")
                if rel.startswith(prefix):
                    out.append(rel)
        return sorted(out)


class Http:
    """出站 HTTP：唯一通道，平台侧逐请求核对 manifest 域名白名单。

    返回 {"status": 上游 HTTP 状态码, "body": 上游响应文本（≤500KB）}；
    白名单拒绝 / URL 非法等平台侧拒绝以异常抛出（RuntimeError）。"""

    def fetch(self, url, timeout=15, headers=None):
        """出站 GET。headers：可选自定义请求头 dict（如第三方 API 鉴权头；
        平台侧剥除逐跳头并限数量/长度）。密钥请从 os.environ 取（门户注入），不要硬编码。"""
        payload = {"url": url}
        if headers:
            payload["headers"] = {str(k): str(v) for k, v in headers.items()}
        status, resp = _platform("/api/aap/egress", payload, timeout=timeout + 5)
        # 平台 JSON = {"status": 上游状态码, "body": 文本}；status 键缺失时回退平台状态
        return {"status": resp.get("status", status), "body": resp.get("body")}


class AapLog:
    def __init__(self, run_id):
        self._logger = logging.getLogger("aap")
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(logging.Formatter(json.dumps({
            "ts": "%(asctime)s", "level": "%(levelname)s", "run_id": run_id, "msg": "%(message)s",
        })))
        self._logger.addHandler(handler)
        self._logger.setLevel(logging.DEBUG if _env("AAP_DEBUG") == "1" else logging.INFO)

    def debug(self, msg, *args):
        self._logger.debug(msg, *args)

    def info(self, msg, *args):
        self._logger.info(msg, *args)

    def warning(self, msg, *args):
        self._logger.warning(msg, *args)

    def error(self, msg, *args):
        self._logger.error(msg, *args)


def build_aap():
    run_id = _env("AAP_RUN_ID", "local")
    pkg = _env("AAP_PACKAGE_DIR", os.getcwd())
    return type("Aap", (), {
        "log": AapLog(run_id),
        "llm": Llm(),
        "db": Db(_env("AAP_DB_PATH", os.path.join(pkg, "app.sqlite"))),
        "storage": Storage(_env("AAP_STORAGE_DIR", os.path.join(pkg, "storage")), _quota_bytes()),
        "http": Http(),
    })()


def inject(module_dict, aap):
    """把 aap 注入模块命名空间（包内无需 import，直接使用全局 aap）。"""
    module_dict["aap"] = aap


def run_invoked(mod_path, aap):
    """invoked：stdin JSON → handle(input, aap) → stdout JSON。"""
    import runpy

    payload = json.loads(sys.stdin.read() or "{}")
    input_data = payload.get("input", payload) if isinstance(payload, dict) else payload
    ns = runpy.run_path(mod_path, run_name="aap_mod")
    inject(ns, aap)
    if "handle" not in ns:
        json.dump({"error": "包未实现 handle(input, aap) 入口"}, sys.stdout)
        sys.exit(1)
    result = ns["handle"](input_data, aap)
    json.dump(result, sys.stdout, ensure_ascii=False, default=str)
    sys.stdout.write("\n")


def run_serve(mod_path, aap):
    """persistent：以 __main__ 执行 mod.py（flask 自行监听注入的 PORT）。

    mod.py 顶层会阻塞在 app.run()，run_path 不会返回——若只在执行后注入，
    路由处理器里永远看不到 aap。因此先把 aap 挂进 builtins（模块代码在
    执行期与请求期经 builtins 回退可见），run_path 返回后再补模块命名
    空间注入（幂等，兼容不阻塞的写法）。"""
    import builtins
    import runpy

    builtins.aap = aap
    ns = runpy.run_path(mod_path, run_name="__main__")
    inject(ns, aap)


def main():
    mode = _env("AAP_MODE", "run")
    mod_path = _env("AAP_MOD_PATH", "mod.py")
    _install_net_guard()
    aap = build_aap()
    if mode == "serve":
        run_serve(mod_path, aap)
    else:
        run_invoked(mod_path, aap)


# ---------- 出站网络守卫 ----------
def _install_net_guard():
    """SDK 出网唯一「受控」通道 = 平台代理（app-develop.skill v0.2 契约）。
    进程级网络隔离由容器形态（ns/cgroups）保证；在此之前，本守卫在 Python 层
    拦截绕过 aap.http.fetch 的直连出站：connect 仅放行平台地址（AAP_PLATFORM），
    其余 TCP 连接（含 Unix socket）直接报错。设置 AAP_NET_GUARD=0 可关闭
    （aap-dev 本地调试不受影响——开发者自行运行进程时不经过 runner）。
    注意：这是纵深防御，非硬隔离；恶意代码仍可能经 ctypes 等底层手段绕过。"""
    if _env("AAP_NET_GUARD", "1") != "1":
        return
    import socket as _socket
    from urllib.parse import urlparse

    plat = urlparse(_env("AAP_PLATFORM", "http://127.0.0.1:8080"))
    plat_host = (plat.hostname or "").lower()
    plat_port = plat.port or (443 if plat.scheme == "https" else 80)

    _real_socket = _socket.socket

    class GuardedSocket(_real_socket):
        @staticmethod
        def _target(address):
            """(host, port)；解析不了返回 (None, None)。"""
            try:
                if isinstance(address, (tuple, list)) and len(address) >= 2:
                    return address[0], address[1]
            except Exception:
                pass
            return None, None

        def connect(self, address):
            if isinstance(address, str):
                raise RuntimeError("沙箱网络守卫：禁止 Unix socket 直连（出站请用 aap.http.fetch）")
            host, port = self._target(address)
            if host is not None and str(host).lower() == plat_host and port == plat_port:
                return super().connect(address)
            raise RuntimeError(
                "沙箱网络守卫：仅允许访问平台（AAP_PLATFORM=%s:%s），出站请使用 aap.http.fetch"
                % (plat_host, plat_port)
            )

    _socket.socket = GuardedSocket


if __name__ == "__main__":
    main()

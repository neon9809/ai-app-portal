"""
IP 安全分析（ip-analyzer）· .neon-aap Python 包示例（persistent）
================================================================
移植自 github.com/neon9809/ip-analyzer（Flask + AbuseIPDB），按平台规范改造：

- 密钥零持有：ABUSEIPDB_API_KEY 由 manifest.env 声明、门户「环境变量」填值、
  沙箱启动注入（os.environ 读取）；前端不再收集密钥。
- 出站收口：requests/socket 直连全部改为 aap.http.fetch（平台 egress 代理，
  manifest.network 白名单逐请求核验）；DNS PTR 反查因沙箱禁 socket 而移除。
- 路径前缀：所有资源与 API 走相对路径（门户挂载于 /app/ip-analyzer/ 之下）。
- 日志：统一走 logging（"aap.*" logger，与 aap.log 同一条结构化 stderr 通道），
  不用 print（stdout 在沙箱里是协议载体）。
"""
from __future__ import annotations

import csv
import io
import ipaddress
import json
import logging
import os
import re
import threading
import time
import uuid
from datetime import datetime

from flask import Flask, jsonify, request, send_file

# 挂在 runner 注入的 "aap" logger 之下 → 与 aap.log 同一条收口通道（§3.5）
logger = logging.getLogger("aap.ip_analyzer")

ABUSEIPDB_BASE = "https://api.abuseipdb.com/api/v2"
IPINFO_BASE = "https://ipinfo.io"
REQUEST_DELAY = 1.0  # 对上游的礼貌间隔（秒）

PKG_DIR = os.environ.get("AAP_PACKAGE_DIR") or os.path.dirname(os.path.abspath(__file__))

app = Flask(__name__)

# 分析任务表（persistent 进程内长驻；invoked 模式禁这种内存态）
analysis_tasks: dict = {}


def abuseipdb_key() -> str | None:
    key = os.environ.get("ABUSEIPDB_API_KEY", "").strip()
    return key or None


def fetch_json(url: str, headers: dict | None = None) -> tuple[int, dict]:
    """经平台 egress 代理 GET 并解析 JSON，返回 (上游状态码, 解析结果)。
    平台侧拒绝（白名单未声明等）以 RuntimeError 抛出，由调用方兜底。"""
    resp = aap.http.fetch(url, timeout=15, headers=headers)  # noqa: F821 — runner 注入
    status = int(resp.get("status") or 0)
    body = resp.get("body") or ""
    try:
        parsed = json.loads(body) if body else {}
    except ValueError:
        parsed = {}
    return status, parsed


class IPAnalyzer:
    def __init__(self, api_key: str | None):
        self.api_key = api_key

    def get_ipinfo_data(self, ip: str) -> dict:
        """IPinfo 地理/ASN 归属（免费接口，无需鉴权；manifest.network 已声明 ipinfo.io）"""
        try:
            status, data = fetch_json(f"{IPINFO_BASE}/{ip}/json")
            if status != 200 or not isinstance(data, dict):
                logger.warning("ipinfo 查询异常 ip=%s status=%s", ip, status)
                return {}
            org = data.get("org", "") or ""
            return {
                "country": data.get("country", ""),
                "region": data.get("region", ""),
                "city": data.get("city", ""),
                "location": data.get("loc", ""),
                "timezone": data.get("timezone", ""),
                "postal": data.get("postal", ""),
                "org": org,
                "asn": org.split(" ")[0] if org else "",
                "isp": org,
            }
        except Exception as err:  # noqa: BLE001 — 单 IP 查询失败不拖垮整批
            logger.warning("ipinfo 查询失败 ip=%s err=%s", ip, err)
            return {}

    def get_abuseipdb_data(self, ip: str) -> dict:
        """AbuseIPDB 恶意报告信息（Key 请求头鉴权；密钥来自门户注入的环境变量）"""
        if not self.api_key:
            return self._abuse_stub("API密钥未配置")
        from urllib.parse import urlencode

        url = f"{ABUSEIPDB_BASE}/check?" + urlencode({
            "ipAddress": ip,
            "maxAgeInDays": 90,
            "verbose": "",
        })
        try:
            status, data = fetch_json(url, headers={"Key": self.api_key, "Accept": "application/json"})
            if status == 200:
                d = data.get("data", {})
                return {
                    "abuse_confidence": f"{d.get('abuseConfidencePercentage', 0)}%",
                    "usage_type": d.get("usageType", "N/A"),
                    "total_reports": d.get("totalReports", 0),
                    "last_reported": d.get("lastReportedAt", "N/A"),
                    "is_whitelisted": d.get("isWhitelisted", False),
                    "country_match": d.get("countryMatch", True),
                }
            if status == 401:
                return self._abuse_stub("API密钥无效")
            if status == 429:
                return self._abuse_stub("API限额")
            logger.warning("abuseipdb 查询异常 ip=%s status=%s", ip, status)
            return self._abuse_stub(f"API错误({status})")
        except Exception as err:  # noqa: BLE001
            logger.warning("abuseipdb 查询失败 ip=%s err=%s", ip, err)
            return self._abuse_stub("查询失败")

    @staticmethod
    def _abuse_stub(reason: str) -> dict:
        return {
            "abuse_confidence": reason,
            "usage_type": "N/A",
            "total_reports": "N/A",
            "last_reported": "N/A",
            "is_whitelisted": "N/A",
        }

    def analyze_ip_risk(self, ip_data: dict) -> dict:
        """风险评分：AbuseIPDB 置信度 + 举报数量 → 高/中/低/正常"""
        risk_score = 0
        risk_factors: list[str] = []

        confidence_raw = ip_data.get("abuse_confidence", "0%")
        if isinstance(confidence_raw, str) and confidence_raw.endswith("%"):
            try:
                confidence = int(confidence_raw.replace("%", ""))
                if confidence >= 75:
                    risk_score += 50
                    risk_factors.append(f"高恶意置信度({confidence}%)")
                elif confidence >= 25:
                    risk_score += 25
                    risk_factors.append(f"中等恶意置信度({confidence}%)")
                elif confidence > 0:
                    risk_score += 10
                    risk_factors.append(f"低恶意置信度({confidence}%)")
            except ValueError:
                pass

        total_reports = ip_data.get("total_reports", 0)
        if isinstance(total_reports, int) and total_reports > 0:
            if total_reports >= 10:
                risk_score += 20
                risk_factors.append(f"多次举报({total_reports}次)")
            elif total_reports >= 5:
                risk_score += 10
                risk_factors.append(f"举报记录({total_reports}次)")

        if risk_score >= 50:
            risk_level, risk_color = "高风险", "danger"
        elif risk_score >= 25:
            risk_level, risk_color = "中风险", "warning"
        elif risk_score >= 10:
            risk_level, risk_color = "低风险", "info"
        else:
            risk_level, risk_color = "正常", "success"

        return {
            "risk_level": risk_level,
            "risk_score": risk_score,
            "risk_color": risk_color,
            "risk_factors": "; ".join(risk_factors) if risk_factors else "无",
        }

    def analyze_ip(self, ip: str) -> dict:
        result = {"ip": ip, "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
        # 沙箱禁 socket，原 DNS PTR 反查移除（字段保留以兼容前端展示）
        result["dns_ptr"] = ""
        result.update(self.get_ipinfo_data(ip))
        result.update(self.get_abuseipdb_data(ip))
        result.update(self.analyze_ip_risk(result))
        time.sleep(REQUEST_DELAY)
        return result


def is_valid_ip(ip_str: str) -> bool:
    try:
        ipaddress.ip_address(ip_str)
        return True
    except ValueError:
        return False


def parse_and_validate_ips(ip_text: str) -> list[str]:
    """解析候选 IP 列表（逗号/分号/空白分隔，支持 IPv4/IPv6），去重保序"""
    processed = re.sub(r"[,;|]", " ", ip_text)
    seen: set[str] = set()
    unique: list[str] = []
    for token in processed.split():
        token = token.strip()
        if token and is_valid_ip(token) and token not in seen:
            seen.add(token)
            unique.append(token)
    return unique


def analyze_ips_background(task_id: str, ip_list: list[str]) -> None:
    try:
        analyzer = IPAnalyzer(abuseipdb_key())
        results: list[dict] = []
        analysis_tasks[task_id]["status"] = "running"
        analysis_tasks[task_id]["total"] = len(ip_list)
        analysis_tasks[task_id]["completed"] = 0

        for i, ip in enumerate(ip_list):
            if analysis_tasks[task_id]["status"] == "cancelled":
                logger.info("任务已取消 task=%s done=%d", task_id[:8], i)
                break
            try:
                results.append(analyzer.analyze_ip(ip))
                analysis_tasks[task_id]["completed"] = i + 1
                analysis_tasks[task_id]["current_ip"] = ip
            except Exception as err:  # noqa: BLE001 — 单 IP 失败记录后继续
                logger.error("分析失败 ip=%s err=%s", ip, err)
                results.append({"ip": ip, "error": str(err), "risk_level": "未知", "risk_color": "secondary"})

        analysis_tasks[task_id]["status"] = "completed"
        analysis_tasks[task_id]["results"] = results
        analysis_tasks[task_id]["completed_at"] = datetime.now().isoformat()
        logger.info("分析完成 task=%s total=%d", task_id[:8], len(results))
    except Exception as err:  # noqa: BLE001
        logger.error("后台任务失败 task=%s err=%s", task_id[:8], err)
        analysis_tasks[task_id]["status"] = "error"
        analysis_tasks[task_id]["error"] = str(err)


# ---------- 页面与静态资源（相对路径；门户前缀 /app/ip-analyzer/ 由平台反代） ----------

@app.route("/")
def index():
    return send_file(os.path.join(PKG_DIR, "web", "index.html"))


# ---------- API ----------

@app.route("/validate_api", methods=["POST"])
def validate_api():
    """验证已注入的 AbuseIPDB 密钥（用 8.8.8.8 试查）。密钥来自环境变量，前端无需提交。"""
    if not abuseipdb_key():
        return jsonify({"valid": False, "error": "ABUSEIPDB_API_KEY 未配置：请在门户「环境变量」中填写"}), 400
    try:
        from urllib.parse import urlencode

        url = f"{ABUSEIPDB_BASE}/check?" + urlencode({"ipAddress": "8.8.8.8", "maxAgeInDays": 90, "verbose": ""})
        status, _ = fetch_json(url, headers={"Key": abuseipdb_key(), "Accept": "application/json"})
        if status == 200:
            return jsonify({"valid": True, "message": "API密钥验证成功"})
        if status == 401:
            return jsonify({"valid": False, "error": "API密钥无效"}), 400
        if status == 429:
            return jsonify({"valid": False, "error": "API配额已用完"}), 400
        return jsonify({"valid": False, "error": f"API验证失败 (状态码: {status})"}), 400
    except RuntimeError as err:
        logger.warning("密钥验证出站被拒: %s", err)
        return jsonify({"valid": False, "error": "出站请求被平台拒绝（请确认 manifest.network 白名单）"}), 400
    except Exception as err:  # noqa: BLE001
        logger.error("密钥验证异常: %s", err)
        return jsonify({"valid": False, "error": "验证过程中发生错误"}), 500


@app.route("/analyze", methods=["POST"])
def analyze():
    """创建分析任务并起后台线程（persistent 长驻进程，前端轮询进度）"""
    data = request.get_json(silent=True) or {}
    ip_text = str(data.get("ips", "")).strip()
    if not ip_text:
        return jsonify({"error": "请输入IP地址"}), 400
    if not abuseipdb_key():
        return jsonify({"error": "ABUSEIPDB_API_KEY 未配置：请在门户「环境变量」中填写"}), 400

    ip_list = parse_and_validate_ips(ip_text)
    if not ip_list:
        return jsonify({"error": "未找到有效的IP地址（支持IPv4和IPv6）"}), 400
    if len(ip_list) > 200:
        return jsonify({"error": "单次最多分析 200 个IP"}), 400

    task_id = str(uuid.uuid4())
    analysis_tasks[task_id] = {
        "status": "pending",
        "created_at": datetime.now().isoformat(),
        "ip_count": len(ip_list),
        "ip_types": {
            "ipv4": len([ip for ip in ip_list if ":" not in ip]),
            "ipv6": len([ip for ip in ip_list if ":" in ip]),
        },
    }
    threading.Thread(target=analyze_ips_background, args=(task_id, ip_list), daemon=True).start()
    logger.info("分析任务创建 task=%s count=%d", task_id[:8], len(ip_list))
    return jsonify({"task_id": task_id})


@app.route("/status/<task_id>")
def get_status(task_id):
    task = analysis_tasks.get(task_id)
    if not task:
        return jsonify({"error": "任务不存在"}), 404
    return jsonify(task)


@app.route("/results/<task_id>")
def get_results(task_id):
    task = analysis_tasks.get(task_id)
    if not task:
        return jsonify({"error": "任务不存在"}), 404
    if task["status"] != "completed":
        return jsonify({"error": "分析未完成"}), 400
    return jsonify(task["results"])


@app.route("/download/<task_id>")
def download_results(task_id):
    task = analysis_tasks.get(task_id)
    if not task:
        return jsonify({"error": "任务不存在"}), 404
    if task["status"] != "completed":
        return jsonify({"error": "分析未完成"}), 400

    output = io.StringIO()
    if task["results"]:
        writer = csv.DictWriter(output, fieldnames=list(task["results"][0].keys()))
        writer.writeheader()
        writer.writerows(task["results"])
    return send_file(
        io.BytesIO(output.getvalue().encode("utf-8")),
        mimetype="text/csv",
        as_attachment=True,
        download_name=f"ip_analysis_{task_id[:8]}.csv",
    )


if __name__ == "__main__":
    # 平台经 runner 注入 PORT；监听 127.0.0.1，对外只经门户反代（§二 persistent 纪律）。
    # threaded=True：进度轮询与长请求并发。注意：runner 以 __main__ 执行本模块，
    # aap 对象在模块顶层已可见（runner 先行挂载）。
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 8080)), threaded=True)

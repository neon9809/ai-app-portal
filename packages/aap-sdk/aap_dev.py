"""aap-dev — 本地调试沙箱 CLI（app-develop.skill v0.2 §七）。

与生产共用同一 SDK 执行器；差异仅为：mock LLM / 本地资源映射 / 详细日志。

用法：
  python3 aap_dev.py run mod.py --input input.json   # --input 缺省读 stdin
  python3 aap_dev.py run mod.py --reset              # 清空本地 db/storage
（serve / --llm real / --submit 随平台 M4 完整版提供，当前未实装）
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from aap_runtime.runner import build_aap  # noqa: E402


def main():
    parser = argparse.ArgumentParser(prog="aap-dev")
    parser.add_argument("mode", choices=["run"], help="invoked 执行一次")
    parser.add_argument("mod", help="mod.py 路径")
    parser.add_argument("--input", default="-", help="入参 JSON 文件（默认 stdin）")
    parser.add_argument("--llm", default="mock", choices=["mock", "real"])
    parser.add_argument("--reset", action="store_true", help="清空本地 db/storage（.aap-dev/）")
    args = parser.parse_args()

    os.environ.setdefault("AAP_DEBUG", "1")
    os.environ.setdefault("AAP_DB_PATH", ".aap-dev/db.sqlite")
    os.environ.setdefault("AAP_STORAGE_DIR", ".aap-dev/storage")
    if args.reset:
        import shutil
        shutil.rmtree(".aap-dev", ignore_errors=True)

    import runpy
    aap = build_aap()
    if args.llm == "real":
        print("[aap-dev] --llm real 需经平台网关；本地仅支持 mock", file=sys.stderr)

    input_text = sys.stdin.read() if args.input == "-" else open(args.input, encoding="utf-8").read()
    input_data = json.loads(input_text or "{}")

    ns = runpy.run_path(args.mod, run_name="aap_mod")
    ns["aap"] = aap
    if "handle" not in ns:
        print(json.dumps({"error": "包未实现 handle(input, aap)"}), file=sys.stderr)
        sys.exit(1)
    result = ns["handle"](input_data, aap)
    print(json.dumps(result, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()

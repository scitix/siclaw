#!/usr/bin/env python3
"""kb_audit.py — 按 Profile 跑审计:脊椎(通用 lint,总跑)+ 叶子(已注册维度,条件跑)。

本调度器零领域知识。Profile 是唯一放 KB 专属配置的地方:
  - 脊椎 always:lint_links(域无关链接审计)。
  - 叶子 conditional:Profile 注册了哪个可选维度就跑哪个;裸库无注册 → 只跑脊椎。
  - 宪法 loaded-not-baked:Profile 指向哪份宪法就是哪份,框架不内置任何一份。
"""
import argparse
import subprocess
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.exit("✗ 需要 PyYAML:pip install pyyaml")

HERE = Path(__file__).resolve().parent


def main():
    ap = argparse.ArgumentParser(description="按 Profile 审计一个 OKF bundle")
    ap.add_argument("--profile", required=True, help="Profile YAML 路径")
    a = ap.parse_args()

    prof = yaml.safe_load(Path(a.profile).expanduser().read_text(encoding="utf-8"))
    root = Path(prof["bundle_root"]).expanduser()
    audit = prof.get("audit") or {}
    reserved = ",".join(audit.get("reserved_extra") or [])
    styles = ",".join(audit.get("link_styles") or ["markdown"])

    print(f"── kb-audit · {prof.get('name', '?')} ──────────────")

    # 脊椎:总跑
    print(f"[脊椎] 通用链接 lint   bundle={root}")
    cmd = [sys.executable, str(HERE / "lint_links.py"), "--root", str(root)]
    if reserved:
        cmd += ["--reserved-extra", reserved]
    if styles:
        cmd += ["--link-styles", styles]
    rc = subprocess.run(cmd).returncode

    # 叶子:条件跑(本砖只登记+校验注册,不执行叶子工具——执行是后续砖)
    dims = audit.get("dimensions") or {}
    print(f"\n[叶子] 已注册可选维度:{len(dims)}")
    if not dims:
        print("  (无 — 裸库,只跑脊椎。这正是'不假设库长啥样'的体现)")
    for name, cfg in dims.items():
        tool = (cfg or {}).get("tool") if isinstance(cfg, dict) else None
        ok = bool(tool) and Path(tool).expanduser().exists()
        mark = f"已注册→{tool}" if ok else "注册无效/缺工具"
        print(f"  · {name}: {mark}（本砖暂不执行叶子）")

    print(f"\n宪法(loaded-not-baked):{prof.get('constitution') or '（未装载,合法）'}")
    sys.exit(rc)


if __name__ == "__main__":
    main()

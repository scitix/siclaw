#!/usr/bin/env python3
"""lint_links.py — OKF bundle 内部链接审计(域无关,只读,不改任何内容)。

机制层工具:对"一个目录的 OKF markdown"做导航完整性检查,不假设任何领域分类法。
  - 节点 = bundle 下每个 .md 文件(相对 posix 路径为 id)。
  - 边   = markdown 链接 ](target.md) 解析到 bundle 内的文件;可选 [[wikilink]]。
  - OKF 保留名 index.md / log.md 不计孤儿(目录/子目录索引、变更日志)。
  - 报告:节点 / 边 / 坏链(指向不存在的页)/ 孤儿(无出入边)/ 无入边页。
退出码:有坏链 → 1(可导航是 OKF 链接约定);否则 → 0。

唯一普适假设 = "一棵 OKF markdown 树"。领域专属(额外保留文件、链接风格、
其它可选维度)全部由 Profile 注入,本工具不内置任何库的具体知识。
"""
import argparse
import json
import posixpath
import re
import sys
from pathlib import Path

OKF_RESERVED = {"index.md", "log.md"}        # OKF SPEC 保留文件名(非领域内容)
MDLINK_RE = re.compile(r"\]\(([^)]+)\)")
WIKILINK_RE = re.compile(r"\[\[([^\]]+)\]\]")


def list_pages(root):
    return {p.relative_to(root).as_posix(): p for p in sorted(root.rglob("*.md"))}


def resolve(raw, src_rel, root):
    """把一条链接文本解析成 bundle 内的相对 posix 路径;非内部页返回 None。"""
    s = raw.strip().split("#", 1)[0].strip()                 # 去 #anchor
    if not s or "://" in s or not s.endswith(".md"):          # 外链/非 md 不是内部边
        return None
    full = posixpath.normpath(posixpath.join(posixpath.dirname(src_rel), s))
    if full.startswith(".."):                                 # 逃出 bundle 根 → 外部
        return None
    return full


def extract(text, src_rel, root, link_styles):
    out = []
    if "markdown" in link_styles:
        for m in MDLINK_RE.finditer(text):
            t = resolve(m.group(1), src_rel, root)
            if t:
                out.append(t)
    if "wikilink" in link_styles:
        for m in WIKILINK_RE.finditer(text):
            g = m.group(1).split("|", 1)[0]                   # [[target|alias]]
            if g.endswith(".md"):
                t = resolve(g, src_rel, root)
                if t:
                    out.append(t)
    return out


def audit(root, reserved, link_styles):
    pages = list_pages(root)
    existing = set(pages)
    out_edges = {rel: set() for rel in pages}
    inbound = {}
    broken = {}
    for rel, path in pages.items():
        dsts = set(extract(path.read_text(encoding="utf-8"), rel, root, link_styles))
        dsts.discard(rel)
        for d in dsts:
            if d in existing:
                out_edges[rel].add(d)
                inbound.setdefault(d, set()).add(rel)
            else:
                broken.setdefault(d, set()).add(rel)

    def is_reserved(rel):
        return Path(rel).name in reserved

    orphans = sorted(p for p in existing
                     if not is_reserved(p) and not inbound.get(p) and not out_edges[p])
    no_inbound = sorted(p for p in existing
                        if not is_reserved(p) and not inbound.get(p))
    return {
        "nodes": len(existing),
        "edges": sum(len(v) for v in out_edges.values()),
        "broken": {k: sorted(v) for k, v in sorted(broken.items())},
        "orphans": orphans,
        "no_inbound": no_inbound,
    }


def main():
    ap = argparse.ArgumentParser(description="OKF bundle 内部链接审计(域无关)")
    ap.add_argument("--root", required=True, help="OKF bundle 目录")
    ap.add_argument("--reserved-extra", default="",
                    help="逗号分隔:除 OKF index.md/log.md 外额外不计孤儿的文件名")
    ap.add_argument("--link-styles", default="markdown",
                    help="逗号分隔:markdown[,wikilink]")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    a = ap.parse_args()

    root = Path(a.root).expanduser().resolve()
    if not root.is_dir():
        sys.exit(f"✗ bundle 根不存在: {root}")
    reserved = OKF_RESERVED | {x.strip() for x in a.reserved_extra.split(",") if x.strip()}
    styles = [x.strip() for x in a.link_styles.split(",") if x.strip()]

    r = audit(root, reserved, styles)
    if a.json:
        print(json.dumps(r, ensure_ascii=False, indent=2))
    else:
        print(f"节点 {r['nodes']} · 边 {r['edges']} · 坏链 {len(r['broken'])} · "
              f"孤儿 {len(r['orphans'])} · 无入边 {len(r['no_inbound'])}")
        if r["broken"]:
            print("\n坏链(指向不存在的页):")
            for dst, srcs in r["broken"].items():
                print(f"  ✗ {dst}  ←被 {len(srcs)} 页引用: {', '.join(srcs)}")
        if r["orphans"]:
            print("\n孤儿(无出入边):")
            for p in r["orphans"]:
                print(f"  · {p}")
    sys.exit(1 if r["broken"] else 0)


if __name__ == "__main__":
    main()

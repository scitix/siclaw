#!/usr/bin/env python3
"""forge_client —— L3 平台化最底层的"哑工具":只会跟 git forge(Forgejo/Gitea)的 REST API 说话。

它对知识库一无所知(不懂矛盾/MCQ/宪法/集群),只提供机械调用:
  开 issue · 读 issue+回复 · 加评论/关 issue · 读写仓里文件 · 建分支 · 开 PR
bridge.py 在它之上做"矛盾 ↔ issue"的翻译;worker.py 驱动整轮。

设计原则:
  · 无第三方依赖(纯标准库 urllib)——装哪都能跑。
  · fail-fast:非 2xx 直接抛带响应体的错,不吞。
  · 域无关:满嘴 issue/repo/PR,没有一个领域词,天然过"零黑话"。

配置走环境变量,默认指向本地开发 Forgejo:
  KBC_FORGE_URL    默认 http://localhost:3300
  KBC_FORGE_TOKEN  默认读 platform/forge/.kbc.token
  KBC_FORGE_REPO   形如 owner/name(CLI 用),如 kbc/aliyun-fc
"""
import argparse
import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_URL = "http://localhost:3300"
TOKEN_FILE = Path(__file__).resolve().parent / "forge" / ".kbc.token"


class ForgeError(RuntimeError):
    """forge API 调用失败。带上 HTTP 码 + 响应体,方便定位。"""


def _read_token_file():
    return TOKEN_FILE.read_text().strip() if TOKEN_FILE.exists() else None


class ForgeClient:
    def __init__(self, repo, base_url=None, token=None):
        self.base = (base_url or os.environ.get("KBC_FORGE_URL", DEFAULT_URL)).rstrip("/")
        self.token = token or os.environ.get("KBC_FORGE_TOKEN") or _read_token_file()
        if not self.token:
            raise ForgeError("缺 forge token:设 KBC_FORGE_TOKEN 或建 platform/forge/.kbc.token")
        self.repo = repo  # "owner/name"

    # ---------- 底层 ----------
    def _req(self, method, path, body=None):
        # 路径里可能含中文文件名(如 bundle/计费.md)→ 百分号编码,保留 URL 结构字符
        url = f"{self.base}/api/v1{urllib.parse.quote(path, safe='/?=&%')}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"token {self.token}")
        req.add_header("Content-Type", "application/json")
        req.add_header("Accept", "application/json")
        try:
            with urllib.request.urlopen(req) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            raise ForgeError(f"{method} {path} -> HTTP {e.code}: {detail}") from None

    # ---------- issue(矛盾的 Web 落点)----------
    def open_issue(self, title, body, labels=None):
        issue = self._req("POST", f"/repos/{self.repo}/issues", {"title": title, "body": body})
        if labels:
            self.add_labels(issue["number"], labels)
        return issue

    def list_issues(self, state="open"):
        return self._req("GET", f"/repos/{self.repo}/issues?state={state}&type=issues")

    def get_issue(self, number):
        return self._req("GET", f"/repos/{self.repo}/issues/{number}")

    def get_comments(self, number):
        return self._req("GET", f"/repos/{self.repo}/issues/{number}/comments")

    def add_comment(self, number, body):
        return self._req("POST", f"/repos/{self.repo}/issues/{number}/comments", {"body": body})

    def close_issue(self, number):
        return self._req("PATCH", f"/repos/{self.repo}/issues/{number}", {"state": "closed"})

    # forge 的打标签要 label id,这里按名字找/建再挂
    def add_labels(self, number, names):
        ids = [self._ensure_label(n) for n in names]
        return self._req("POST", f"/repos/{self.repo}/issues/{number}/labels", {"labels": ids})

    def _ensure_label(self, name, color="#ededed"):
        for lab in self._req("GET", f"/repos/{self.repo}/labels"):
            if lab["name"] == name:
                return lab["id"]
        return self._req("POST", f"/repos/{self.repo}/labels", {"name": name, "color": color})["id"]

    # ---------- 文件 / 分支 / PR(知识库改动的落点)----------
    def get_file(self, path, ref="main"):
        """读仓里某文件的文本;不存在返回 None。"""
        try:
            r = self._req("GET", f"/repos/{self.repo}/contents/{path}?ref={ref}")
        except ForgeError as e:
            if "HTTP 404" in str(e):
                return None
            raise
        return base64.b64decode(r["content"]).decode()

    def get_file_sha(self, path, ref="main"):
        try:
            return self._req("GET", f"/repos/{self.repo}/contents/{path}?ref={ref}")["sha"]
        except ForgeError as e:
            if "HTTP 404" in str(e):
                return None
            raise

    def create_branch(self, new_branch, old_branch="main"):
        return self._req("POST", f"/repos/{self.repo}/branches",
                         {"new_branch_name": new_branch, "old_branch_name": old_branch})

    def put_file(self, path, content, branch, message):
        """在某分支上写/改一个文件(自动判断是新建还是更新)。"""
        payload = {"content": base64.b64encode(content.encode()).decode(),
                   "message": message, "branch": branch}
        sha = self.get_file_sha(path, ref=branch)
        if sha:
            payload["sha"] = sha
            return self._req("PUT", f"/repos/{self.repo}/contents/{path}", payload)
        return self._req("POST", f"/repos/{self.repo}/contents/{path}", payload)

    def open_pr(self, head, base, title, body):
        return self._req("POST", f"/repos/{self.repo}/pulls",
                         {"head": head, "base": base, "title": title, "body": body})

    def commit_files(self, files, branch, message):
        """一次提交多个文件(create/update 自动判断)。files: {path: 文本内容}。"""
        entries = []
        for path, content in files.items():
            sha = self.get_file_sha(path, ref=branch)
            entry = {"operation": "update" if sha else "create", "path": path,
                     "content": base64.b64encode(content.encode()).decode()}
            if sha:
                entry["sha"] = sha
            entries.append(entry)
        return self._req("POST", f"/repos/{self.repo}/contents",
                         {"branch": branch, "message": message, "files": entries})

    def create_release(self, tag, target="main", name=None, body=""):
        """发布一个不可变版本 = 打 tag + 带发布说明(release)。"""
        return self._req("POST", f"/repos/{self.repo}/releases",
                         {"tag_name": tag, "target_commitish": target,
                          "name": name or tag, "body": body})

    def list_releases(self):
        return self._req("GET", f"/repos/{self.repo}/releases")

    def list_tree(self, ref="main"):
        """列出某 ref(分支或 tag)下所有文件路径。"""
        t = self._req("GET", f"/repos/{self.repo}/git/trees/{ref}?recursive=true")
        return [e["path"] for e in t.get("tree", []) if e.get("type") == "blob"]


# ========================= CLI / 自检 =========================
def _smoke(fc):
    """端到端自检:开 issue → 读回 → 评论 → 建分支+提文件 → 开 PR。验证三类调用都通。"""
    print(f"[smoke] repo = {fc.repo}  base = {fc.base}")

    print("\n[1] 开一条 issue(模拟一个待裁决的矛盾)")
    body = ("〔来源 计费(fc).md〕实例数上限 = 300\n"
            "〔来源 计费(fc-2-0).md〕实例数上限 = 100\n\n"
            "① 以 300 为准  ② 以 100 为准  ③ 两版分别保留(不同版本)  ④ 我也不确定→存疑")
    issue = fc.open_issue("🔧[smoke] 实例数上限对不上(300 vs 100)", body, labels=["待裁决"])
    n = issue["number"]
    print(f"    -> issue #{n}  {issue['html_url']}")

    print("\n[2] 读回这条 issue")
    got = fc.get_issue(n)
    print(f"    -> 标题: {got['title']}  状态: {got['state']}  标签: {[l['name'] for l in got['labels']]}")

    print("\n[3] 模拟有人回复一个裁决")
    fc.add_comment(n, "②")
    comments = fc.get_comments(n)
    print(f"    -> 回复数: {len(comments)}  最新: {comments[-1]['body']!r}")

    print("\n[4] 建分支 + 提交一个文件(模拟编译产物)")
    branch = "smoke/forge-client-selftest"
    try:
        fc.create_branch(branch)
        print(f"    -> 分支 {branch} 已建")
    except ForgeError as e:
        print(f"    -> 分支可能已存在,继续: {str(e)[:80]}")
    fc.put_file("bundle/_smoke.md",
                "# smoke\nforge_client 自检写入的占位文件,可删。\n",
                branch=branch, message="smoke: forge_client 自检")
    print("    -> 文件 bundle/_smoke.md 已提交到分支")

    print("\n[5] 开一个 PR(模拟把知识库改动提上去待审)")
    try:
        pr = fc.open_pr(head=branch, base="main",
                        title="🔧[smoke] forge_client 自检 PR",
                        body="自检用,验证开 PR 通路。可关。")
        print(f"    -> PR #{pr['number']}  {pr['html_url']}")
    except ForgeError as e:
        print(f"    -> 开 PR: {str(e)[:120]}")

    print("\n[smoke] ✅ 三类调用(issue / 评论 / 文件+PR)全通。去浏览器看:")
    print(f"        {fc.base}/{fc.repo}/issues")
    print(f"        {fc.base}/{fc.repo}/pulls")


def main(argv=None):
    p = argparse.ArgumentParser(description="forge_client —— forge REST 的哑封装 + 自检")
    p.add_argument("--repo", default=os.environ.get("KBC_FORGE_REPO", "kbc/aliyun-fc"))
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("smoke", help="端到端自检")
    pi = sub.add_parser("open-issue"); pi.add_argument("title"); pi.add_argument("body")
    sub.add_parser("list-issues")
    pc = sub.add_parser("comments"); pc.add_argument("number", type=int)
    args = p.parse_args(argv)

    fc = ForgeClient(args.repo)
    if args.cmd == "smoke":
        _smoke(fc)
    elif args.cmd == "open-issue":
        print(json.dumps(fc.open_issue(args.title, args.body), ensure_ascii=False, indent=2))
    elif args.cmd == "list-issues":
        for it in fc.list_issues():
            print(f"#{it['number']}  [{it['state']}]  {it['title']}")
    elif args.cmd == "comments":
        for c in fc.get_comments(args.number):
            print(f"- {c['user']['login']}: {c['body']!r}")


if __name__ == "__main__":
    main()

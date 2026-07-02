#!/usr/bin/env python3
"""llm.py — Claude 调用封装。

后端 = headless Claude Code(`claude -p --output-format json`):复用 Claude Code 鉴权,
**无需 API key** —— 部署只要装了 Claude Code 即可。模型默认 claude-opus-4-8。
想用直连 API key 的部署:把 call_json 内部换成 Anthropic Messages API SDK
(messages.parse + 结构化输出),对外接口不变。
"""
import json
import subprocess

MODEL = "claude-opus-4-8"


def call_text(prompt, model=MODEL, timeout=300):
    """跑一次 Claude,返回模型输出的纯文本。"""
    proc = subprocess.run(
        ["claude", "-p", prompt, "--output-format", "json", "--model", model],
        capture_output=True, text=True, timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"claude 调用失败(rc={proc.returncode}): {proc.stderr[:500]}")
    env = json.loads(proc.stdout)
    if env.get("is_error"):
        raise RuntimeError(f"claude 报错: {str(env.get('result', ''))[:500]}")
    return env.get("result", "")


def call_json(prompt, model=MODEL, timeout=300):
    """跑一次 Claude(要求模型只输出 JSON),返回解析后的 dict。"""
    return _parse_json(call_text(prompt, model, timeout))


def _parse_json(text):
    t = text.strip()
    if t.startswith("```"):                       # 去掉可能的 ```json 围栏
        t = t.split("```")[1]
        if t.startswith("json"):
            t = t[4:]
        t = t.strip()
    return json.loads(t)

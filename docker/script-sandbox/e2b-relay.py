"""Trusted E2B relay. Root owns HTTP; UID 10001 owns the existing pipe runner.

Task grants arrive on authenticated envd stdin, never in env/argv/work files.
No production credentials enter this VM. Untrusted frames still go through
Runtime's active-run authorization, validation and shared tool budget.
"""
import ctypes
import json
import os
import resource
import signal
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
import urllib.request
from urllib.parse import urlsplit

MAX_FRAME = 256 * 1024


def read_frame(stream, extra=0):
    line = stream.readline(MAX_FRAME + extra + 1)
    if not line or len(line) > MAX_FRAME + extra or not line.endswith(b"\n"):
        raise RuntimeError("Invalid relay frame")
    value = json.loads(line)
    if not isinstance(value, dict):
        raise RuntimeError("Invalid relay frame")
    return value


def send(stream, value):
    line = (json.dumps(value, ensure_ascii=False) + "\n").encode()
    if len(line) > MAX_FRAME:
        raise RuntimeError("Relay frame too large")
    stream.write(line)
    stream.flush()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise RuntimeError("Redirect denied")


def main():
    if os.getuid() != 0 or len(sys.argv) != 3 or sys.argv[1] not in ("standard", "isolated"):
        raise RuntimeError("Invalid relay launch")
    # Hide supervisor memory, fds and stdin from the unprivileged script.
    if ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0) != 0:  # PR_SET_DUMPABLE
        raise RuntimeError("Relay isolation unavailable")
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    lifetime = min(max(int(sys.argv[2]), 1), 3600)
    signal.signal(signal.SIGALRM, lambda *_: os._exit(124))
    signal.alarm(lifetime)
    child = subprocess.Popen(
        ["/usr/local/bin/siclaw-launcher", sys.argv[1], "/usr/local/bin/python3",
         "-I", "-B", "-u", "/opt/siclaw/runner.py", str(lifetime)],
        cwd="/work", env={}, user=10001, group=10001, extra_groups=[],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        close_fds=True, start_new_session=True,
    )
    try:
        hello = read_frame(sys.stdin.buffer)
        if hello != {"type": "hello", "version": 3}:
            raise RuntimeError("Expected hello")
        send(child.stdin, hello)
        ready = read_frame(child.stdout)
        if ready != {"type": "ready", "version": 3}:
            raise RuntimeError("Runner unavailable")
        send(sys.stdout.buffer, ready)
        config = read_frame(sys.stdin.buffer, 4096)
        if set(config) != {"type", "endpoint", "token", "start"} or config["type"] != "configure":
            raise RuntimeError("Expected relay configuration")
        endpoint, token = config["endpoint"], config["token"]
        u = urlsplit(endpoint)
        if (u.scheme != "https" or not u.hostname or u.username or u.password or
                u.query or u.fragment or u.path != "/api/v1/siclaw/sandbox/tools" or
                not isinstance(token, str) or len(token) != 64 or
                any(c not in "0123456789abcdef" for c in token)):
            raise RuntimeError("Invalid relay grant")
        send(child.stdin, config["start"])
        del config
        writers = threading.Lock()
        slots = threading.BoundedSemaphore(10)
        pool = ThreadPoolExecutor(max_workers=10)
        pending = 0
        def invoke(call):
            nonlocal pending
            try:
                body = json.dumps({"call": call}, ensure_ascii=False).encode()
                if len(body) > MAX_FRAME:
                    raise RuntimeError("Tool request too large")
                request = urllib.request.Request(endpoint, data=body, method="POST", headers={
                    "Authorization": "Bearer " + token, "Content-Type": "application/json",
                })
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
                # Never retry an uncertain remote execution.
                try:
                    with opener.open(request, timeout=140 if isinstance(call, dict) and call.get("tool") == "node_exec" else 70) as response:
                        data = response.read(MAX_FRAME + 1)
                        if response.status != 200 or len(data) > MAX_FRAME:
                            raise RuntimeError("Tool response unavailable")
                        result = json.loads(data)
                except urllib.error.HTTPError as error:
                    if error.code in (401, 403) or 300 <= error.code < 400:
                        raise  # Revoked grant or redirect: terminate this run.
                    result = {"id": call["id"], "error": "Tool execution is unconfirmed; do not automatically retry",
                              "code": "EXECUTION_UNKNOWN", "execution": "UNKNOWN", "cleanup": "not_required"}
                except (urllib.error.URLError, TimeoutError, ConnectionError):
                    result = {"id": call["id"], "error": "Tool execution is unconfirmed; do not automatically retry",
                              "code": "EXECUTION_UNKNOWN", "execution": "UNKNOWN", "cleanup": "not_required"}
                if not isinstance(result, dict) or result.get("id") != call.get("id"):
                    raise RuntimeError("Mismatched tool response")
                with writers:
                    slots.release()
                    send(child.stdin, {"type": "tool_result", "response": result})
                    pending -= 1
            except Exception:
                # Wakes the reader; the outer failure closes this one-use VM.
                child.kill()
        while True:
            frame = read_frame(child.stdout)
            if frame.get("type") == "tool":
                if not slots.acquire(blocking=False):
                    raise RuntimeError("Too many concurrent callbacks")
                with writers:
                    pending += 1
                pool.submit(invoke, frame.get("call"))
            elif frame.get("type") in ("stdout", "stderr", "exit"):
                if frame["type"] == "exit":
                    with writers:
                        if pending:
                            raise RuntimeError("Runner exited with active callbacks")
                    pool.shutdown(wait=True)
                    send(sys.stdout.buffer, frame)
                    return
                send(sys.stdout.buffer, frame)
            else:
                raise RuntimeError("Invalid runner output")
    finally:
        child.kill()
        child.wait(timeout=3)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Avoid leaking URLs, headers, tokens or remote error bodies through envd.
        sys.stderr.write("Sandbox relay unavailable\n")
        sys.stderr.flush()
        os._exit(125)

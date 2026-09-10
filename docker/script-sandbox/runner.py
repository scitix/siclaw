"""One-use stdio runner. No production credentials or network clients.

All processes in the container are untrusted from the Runtime's perspective.
The optional seccomp launcher constrains this process and all descendants before
this module loads. stdout is framed RPC; script stdout/stderr are framed data.
"""
import json
import os
import signal
import subprocess
import sys
import threading
from pathlib import Path

MAX_FRAME = 256 * 1024
write_lock = threading.Lock()


def emit(frame):
    encoded = (json.dumps(frame, ensure_ascii=False) + "\n").encode()
    if len(encoded) > MAX_FRAME:
        raise RuntimeError("Protocol frame exceeds limit")
    with write_lock:
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()


def read_frame(stream):
    line = stream.readline(MAX_FRAME + 1)
    if not line:
        raise EOFError("Closed protocol stream")
    if len(line) > MAX_FRAME or not line.endswith(b"\n"):
        raise RuntimeError("Invalid or closed protocol stream")
    frame = json.loads(line)
    if not isinstance(frame, dict):
        raise RuntimeError("Protocol frame must be an object")
    return frame


def main():
    # Lifetime also bounds orphaned containers after a Runtime crash.
    lifetime = int(sys.argv[1]) if len(sys.argv) > 1 else 900
    signal.signal(signal.SIGALRM, lambda *_: os._exit(124))
    signal.alarm(min(max(lifetime, 1), 3600))
    # Respond only after attach; startup stdout can otherwise be lost in K8s.
    hello = read_frame(sys.stdin.buffer)
    if hello != {"type": "hello", "version": 2}:
        raise RuntimeError("Expected hello")
    emit({"type": "ready", "version": 2})
    frame = read_frame(sys.stdin.buffer)
    if frame.get("type") != "start" or frame.get("language") not in ("python", "shell"):
        raise RuntimeError("Expected a start frame")
    code = frame.get("code")
    if not isinstance(code, str) or len(code.encode()) > 128 * 1024:
        raise RuntimeError("Invalid script")
    work = Path.cwd()
    script = work / ("main.py" if frame["language"] == "python" else "main.sh")
    script.write_text(code, encoding="utf-8")
    input_file = work / "input.json"
    input_file.write_text(json.dumps(frame.get("input")), encoding="utf-8")
    request_read, request_write = os.pipe()
    response_read, response_write = os.pipe()
    # No inherited environment, including cloud identity, loader settings or keys.
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": str(work), "TMPDIR": "/tmp", "LANG": "C.UTF-8",
        "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1",
        "SICLAW_INPUT_FILE": str(input_file),
        "SICLAW_RPC_LOCK_FILE": str(work / ".rpc.lock"),
        "SICLAW_RPC_REQUEST_FD": str(request_write),
        "SICLAW_RPC_RESPONSE_FD": str(response_read),
    }
    if frame["language"] == "python":
        # The SDK is in the immutable image, not resolved from task input.
        driver = "import sys,runpy;sys.path.insert(0,sys.argv[1]);runpy.run_path(sys.argv[2],run_name='__main__')"
        command = [sys.executable, "-I", "-B", "-u", "-c", driver, str(Path(__file__).parent), str(script)]
    else:
        command = ["/bin/bash", "--noprofile", "--norc", str(script)]
    child = subprocess.Popen(command, cwd=work, env=env, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             pass_fds=(request_write, response_read), start_new_session=True)
    os.close(request_write)
    os.close(response_read)
    failed = threading.Event()

    def stop():
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def output(stream, name):
        try:
            while True:
                data = os.read(stream.fileno(), 4096)
                if not data:
                    return
                # Carry incomplete UTF-8 between reads.
                import base64
                emit({"type": name, "data": base64.b64encode(data).decode("ascii")})
        except Exception:
            failed.set()
            stop()

    def requests():
        try:
            with os.fdopen(request_read, "rb") as stream:
                while True:
                    call = read_frame(stream)
                    emit({"type": "tool", "call": call})
        except EOFError:
            return
        except Exception:
            if child.poll() is None:
                failed.set()
                stop()

    def responses():
        try:
            while child.poll() is None:
                response = read_frame(sys.stdin.buffer)
                if response.get("type") != "tool_result":
                    raise RuntimeError("Unexpected response frame")
                data = (json.dumps(response["response"], ensure_ascii=False) + "\n").encode()
                remaining = memoryview(data)
                while remaining:
                    remaining = remaining[os.write(response_write, remaining):]
        except Exception:
            if child.poll() is None:
                failed.set()
                stop()

    threads = [threading.Thread(target=output, args=(child.stdout, "stdout"), daemon=True),
               threading.Thread(target=output, args=(child.stderr, "stderr"), daemon=True),
               threading.Thread(target=requests, daemon=True),
               threading.Thread(target=responses, daemon=True)]
    for thread in threads:
        thread.start()
    exit_code = child.wait()
    stop()  # Descendants must not outlive the foreground script.
    for thread in threads[:2]:
        thread.join(timeout=2)
    emit({"type": "exit", "code": exit_code if not failed.is_set() else 125})
    # Do not wait on a daemon blocked in buffered stdin at interpreter shutdown.
    os._exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stderr.write("Script runner protocol failure\n")
        sys.stderr.flush()
        os._exit(125)

"""Run as root INSIDE the E2B template image, with disposable TLS fixtures.

This tests real Linux UID/seccomp isolation and HTTPS callbacks, not the E2B
cloud control API (covered separately with recorded protocol-shaped fixtures).
"""
import base64
import hashlib
import http.server
import json
import os
import secrets
import ssl
import subprocess
import sys
import threading
import time
from pathlib import Path

token = secrets.token_hex(32)
calls = []
redirected = []
redirect = False
barrier = threading.Barrier(10, timeout=5)
large_data = json.dumps({"rows": ["节点🐍"] * 40_000}, ensure_ascii=False).encode()
transfer_id = "b" * 64


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        if self.path != "/api/v1/siclaw/sandbox/tools":
            redirected.append(True)
            self.send_error(403)
            return
        if self.headers.get("Authorization") != "Bearer " + token:
            self.send_error(401)
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        call = body["call"]
        calls.append(call)
        if redirect:
            self.send_response(307)
            self.send_header("Location", "/redirect-target")
            self.end_headers()
            return
        if call["tool"] == "bash" and call["arguments"] == {"cluster": "test", "command": "kubectl get nodes -o json"}:
            value = {"id": call["id"], "result": {"text": json.dumps({"items": [{"metadata": {"name": "node-1"}}]})}}
        elif call["tool"] == "test.concurrent":
            barrier.wait()  # All ten must reach HTTPS before any response returns.
            value = {"id": call["id"], "result": call["arguments"]}
        elif call["tool"] == "test.echo":
            value = {"id": call["id"], "result": call["arguments"]}
        elif call["tool"] == "test.large" and call.get("delivery") == "file":
            value = {"id": call["id"], "result": {"transfer_id": transfer_id, "bytes": len(large_data), "sha256": hashlib.sha256(large_data).hexdigest(), "encoding": "json-utf8"}}
        elif call["tool"] == "result.read" and call["arguments"]["transfer_id"] == transfer_id:
            offset = call["arguments"]["offset"]
            chunk = large_data[offset:offset + 48 * 1024]
            value = {"id": call["id"], "result": {"data": base64.b64encode(chunk).decode(), "next_offset": offset + len(chunk), "done": offset + len(chunk) == len(large_data)}}
        else:
            value = {"id": call["id"], "error": "Tool request denied or unavailable"}
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(value, ensure_ascii=False).encode())


def run(code, language="python", isolated=True, fail=False):
    started = time.monotonic()
    relay = subprocess.Popen(
        ["/usr/local/bin/python3", "-I", "-B", "-u", "/opt/siclaw/e2b-relay.py",
         "isolated" if isolated else "standard", "30"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env={"SSL_CERT_FILE": "/test-certs/cert.pem"},
    )
    relay.stdin.write(b'{"type":"hello","version":3}\n')
    relay.stdin.flush()
    assert json.loads(relay.stdout.readline()) == {"type": "ready", "version": 3}
    startup_ms = int((time.monotonic() - started) * 1000)
    # Leave only the UID 10001 work files from this run; template state is one-use.
    # Test process reuses the container to avoid cloud/build overhead.
    config = {"type": "configure", "endpoint": endpoint, "token": token,
              "start": {"type": "start", "language": language,
                        "code": code.replace("RELAY_PID", str(relay.pid)), "input": None}}
    output, error = relay.communicate((json.dumps(config) + "\n").encode(), timeout=10)
    assert token.encode() not in output + error
    frames = [json.loads(line) for line in output.splitlines()]
    if fail:
        assert relay.returncode == 125 and error == b"Sandbox relay unavailable\n"
        return
    assert relay.returncode == 0, error
    assert frames[-1] == {"type": "exit", "code": 0}, frames
    text = b"".join(base64.b64decode(f["data"]) for f in frames if f["type"] == "stdout").decode()
    assert "PASS" in text, text
    print(json.dumps({"language": language, "isolated": isolated, "relay_startup_ms": startup_ms, "result": "passed"}))


assert os.getuid() == 0
assert Path("/test-certs/key.pem").stat().st_mode & 0o077 == 0
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain("/test-certs/cert.pem", "/test-certs/key.pem")
server.socket = ctx.wrap_socket(server.socket, server_side=True)
endpoint = "https://127.0.0.1:%s/api/v1/siclaw/sandbox/tools" % server.server_port
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    common = r'''
import json, os, pathlib, socket, subprocess
from siclaw import call
assert os.getuid() == 10001
assert "NoNewPrivs:\t1" in pathlib.Path("/proc/self/status").read_text()
assert not any(k in os.environ for k in ("E2B_API_KEY", "SICLAW_SANDBOX_TOKEN", "SSL_CERT_FILE"))
for path in ("/test-certs/key.pem", "/proc/RELAY_PID/environ", "/proc/RELAY_PID/fd/0", "/proc/RELAY_PID/mem"):
    try:
        open(path, "rb")
        raise AssertionError("root file readable: " + path)
    except PermissionError:
        pass
try:
    os.setuid(0)
    raise AssertionError("privilege escalation")
except PermissionError:
    pass
assert json.loads(call("bash", {"cluster":"test", "command":"kubectl get nodes -o json"})["text"])["items"][0]["metadata"]["name"] == "node-1"
try:
    call("bash", {"cluster":"test", "command":"kubectl delete nodes node-1"})
    raise AssertionError("write accepted")
except RuntimeError:
    pass
'''
    isolated = r'''
try:
    socket.socket()
    raise AssertionError("socket accepted")
except PermissionError:
    pass
assert subprocess.run(["/usr/local/bin/python3", "-c", "import socket; socket.socket()"], capture_output=True).returncode != 0
assert subprocess.run(["/bin/bash", "-c", "echo bad >/dev/tcp/127.0.0.1/443"], capture_output=True).returncode != 0
print("PASS")
'''
    run(common + isolated)
    run(common + '\nsocket.socket().close()\nprint("PASS")\n', isolated=False)
    run('siclaw-tool bash \'{"cluster":"test","command":"kubectl get nodes -o json"}\'\necho PASS\n', language="shell")
    assert len(calls) == 5
    run('''import json
from siclaw import call, call_to_file
assert call("test.echo", {"text": "🐍" * 30000}) == {"text": "🐍" * 30000}
info = call_to_file("test.large", {}, "data.json")
assert json.load(open(info["path"]))["rows"] == ["节点🐍"] * 40000
print("PASS")
''')
    run('''set -e
siclaw-tool --output data.json test.large '{}' > receipt.json
python3 -c 'import json; assert len(json.load(open("data.json"))["rows"]) == 40000; print("PASS")'
''', language="shell")
    run('from concurrent.futures import ThreadPoolExecutor\nfrom siclaw import call\nwith ThreadPoolExecutor(max_workers=10) as pool:\n    rows = list(pool.map(lambda i: call("test.concurrent", {"i":i}), range(10)))\nassert rows == [{"i":i} for i in range(10)]\nprint("PASS")')
    redirect = True
    run('from siclaw import call\ncall("bash", {"cluster":"test", "command":"kubectl get nodes -o json"})\n', fail=True)
    assert not redirected
    print("HTTPS redirect rejection: passed")
finally:
    server.shutdown()
    server.server_close()

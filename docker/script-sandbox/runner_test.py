"""Real stdio/SDK tests. Trusted fixtures only; this is not an isolation test."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import hashlib

RUNNER = str(Path(__file__).with_name("runner.py"))


class RunnerTest(unittest.TestCase):
    def run_script(self, code, language="python", input_data=None, responder=None):
        with tempfile.TemporaryDirectory() as work:
            process = subprocess.Popen([sys.executable, "-I", "-B", "-u", RUNNER, "10"], cwd=work,
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       env={**os.environ, "FAKE_PRODUCTION_SECRET": "must-not-inherit"})
            def send(value):
                process.stdin.write((json.dumps(value, ensure_ascii=False) + "\n").encode())
                process.stdin.flush()
            try:
                send({"type": "hello", "version": 3})
                self.assertEqual(json.loads(process.stdout.readline()), {"type": "ready", "version": 3})
                send({"type": "start", "language": language, "code": code, "input": input_data})
                output = {"stdout": bytearray(), "stderr": bytearray()}
                calls = []
                while True:
                    line = process.stdout.readline()
                    self.assertTrue(line, process.stderr.read().decode() if not line else "")
                    frame = json.loads(line)
                    if frame["type"] == "exit":
                        self.assertEqual(frame["code"], 0, output["stderr"].decode())
                        break
                    if frame["type"] == "tool":
                        calls.append(frame["call"])
                        response = responder(frame["call"]) if responder else {"id": frame["call"]["id"], "result": {"pods": ["one"]}}
                        responses = response if isinstance(response, list) else [response] if response is not None else []
                        for item in responses:
                            send({"type": "tool_result", "response": item})
                    else:
                        output[frame["type"]].extend(base64.b64decode(frame["data"]))
                self.assertEqual(process.wait(timeout=5), 0)
                return output["stdout"].decode(), calls
            finally:
                process.kill()
                process.wait()
                process.stdin.close()
                process.stdout.close()
                process.stderr.close()

    def test_python_sdk_and_clean_environment(self):
        out, calls = self.run_script('''import os
from siclaw import call, input_data
assert "FAKE_PRODUCTION_SECRET" not in os.environ
assert input_data() == {"count": 2}
for _ in range(2):
    print(call("bash", {"cluster": "c", "command": "kubectl get pods -n ns"}))
''', input_data={"count": 2})
        self.assertEqual(len(calls), 2)
        self.assertIn("one", out)

    def ten_reversed_responses(self):
        pending = []
        def respond(call):
            pending.append(call)
            if len(pending) == 10:
                return [{"id": c["id"], "result": c["arguments"]} for c in reversed(pending)]
        return respond

    def test_ten_python_calls_are_in_flight_and_large_responses_cannot_cross(self):
        out, calls = self.run_script('''from concurrent.futures import ThreadPoolExecutor
from siclaw import call
def query(i):
    args = {"index": i, "text": str(i) * 100000}
    assert call("test.echo", args) == args
    return i
with ThreadPoolExecutor(max_workers=10) as workers:
    assert list(workers.map(query, range(10))) == list(range(10))
print("parallel-python-ok")
''', responder=self.ten_reversed_responses())
        self.assertEqual(len(calls), 10)
        self.assertEqual(out, "parallel-python-ok\n")

    def test_ten_shell_processes_share_bounded_lanes_with_out_of_order_results(self):
        import shlex
        sdk = shlex.quote(str(Path(RUNNER).with_name("siclaw.py")))
        python = shlex.quote(sys.executable)
        commands = [f'{python} {sdk} test.echo \'{{"index":{i}}}\' > result-{i}.json &' for i in range(10)]
        commands += ['wait', f'''{python} -c 'import json; assert [json.load(open("result-%d.json" % i))["index"] for i in range(10)] == list(range(10)); print("parallel-shell-ok")' ''']
        out, calls = self.run_script('\n'.join(commands), language="shell", responder=self.ten_reversed_responses())
        self.assertEqual(len(calls), 10)
        self.assertEqual(out, "parallel-shell-ok\n")

    def test_shell_and_subprocess(self):
        out, _ = self.run_script('test -z "$FAKE_PRODUCTION_SECRET" && printf "shell works\\n"', "shell")
        self.assertEqual(out, "shell works\n")

    def test_killed_client_large_reply_does_not_block_nine_peers_or_reuse_stale_reply(self):
        import signal
        pending = []
        def respond(call):
            if call["arguments"]["index"] == 10:
                return {"id": call["id"], "result": 10}
            pending.append(call)
            if len(pending) != 10:
                return None
            abandoned = next(c for c in pending if c["arguments"]["index"] == 0)
            os.kill(abandoned["arguments"]["pid"], signal.SIGKILL)
            return [{"id": abandoned["id"], "result": "x" * 90000}] + [
                {"id": c["id"], "result": c["arguments"]["index"]} for c in pending if c is not abandoned]
        out, calls = self.run_script('''import multiprocessing, os
from siclaw import call
def query(index):
    result = call("test.echo", {"index": index, "pid": os.getpid()})
    assert result == index
workers = [multiprocessing.get_context("fork").Process(target=query, args=(i,)) for i in range(10)]
for worker in workers: worker.start()
for worker in workers: worker.join(4)
assert workers[0].exitcode == -9
assert all(worker.exitcode == 0 for worker in workers[1:])
assert call("test.echo", {"index": 10}) == 10
print("nine-peers-and-reuse-ok")
''', responder=respond)
        self.assertEqual(len(calls), 11)
        self.assertEqual(out, "nine-peers-and-reuse-ok\n")

    def test_sdk_exposes_execution_state_without_automatic_retry(self):
        out, calls = self.run_script('''from siclaw import call, ToolError
try:
    call("test.echo", {})
except ToolError as error:
    assert error.code == "TARGET_BUSY" and error.execution == "NOT_DISPATCHED"
    assert error.retry_after_ms == 1000
    print("typed-error-ok")
''', responder=lambda c: {"id": c["id"], "error": "busy", "code": "TARGET_BUSY", "execution": "NOT_DISPATCHED", "retry_after_ms": 1000})
        self.assertEqual(len(calls), 1)
        self.assertEqual(out, "typed-error-ok\n")

    def test_normal_eof_is_not_a_protocol_failure(self):
        for _ in range(10):
            out, _ = self.run_script('print("ok")')
            self.assertEqual(out, "ok\n")

    def test_large_output_does_not_deadlock(self):
        out, _ = self.run_script('print("x" * 100000)')
        self.assertEqual(len(out), 100001)

    def test_runs_do_not_reuse_files(self):
        self.run_script('from pathlib import Path; Path("sentinel").write_text("user-one")')
        out, _ = self.run_script('from pathlib import Path; print(Path("sentinel").exists())')
        self.assertEqual(out, "False\n")

    def test_unicode_request_and_response_use_utf8_byte_budget(self):
        value = "🐍" * 30_000
        out, calls = self.run_script('''from siclaw import call, input_data
assert call("test.echo", {"text":input_data()}) == input_data()
print("unicode-ok")
''', input_data=value, responder=lambda c: {"id": c["id"], "result": c["arguments"]["text"]})
        self.assertEqual(out, "unicode-ok\n")
        self.assertEqual(calls[0]["arguments"]["text"], value)

    def file_responder(self, value, broken=False):
        data = json.dumps(value, ensure_ascii=False).encode()
        transfer_id = "a" * 64
        def respond(call):
            if call["tool"] == "result.discard":
                result = {"discarded": True}
            elif call["tool"] == "result.read":
                args = call["arguments"]
                self.assertEqual(args["transfer_id"], transfer_id)
                offset = args["offset"]
                if broken and offset:
                    return {"id": call["id"], "error": "Authorization revoked"}
                chunk = data[offset:offset + 48 * 1024]
                result = {"data": base64.b64encode(chunk).decode(), "next_offset": offset + len(chunk), "done": offset + len(chunk) == len(data)}
            else:
                self.assertEqual(call.get("delivery"), "file")
                result = {"transfer_id": transfer_id, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "encoding": "json-utf8"}
            return {"id": call["id"], "result": result}
        return respond

    def test_large_file_is_complete_and_only_summary_is_printed(self):
        out, calls = self.run_script('''import json
from siclaw import call_to_file
info=call_to_file("test.query", {}, "data.json")
with open(info["path"]) as f:
    data=json.load(f)
assert data["rows"] == ["节点🐍"] * 40_000
print(len(data["rows"]))
''', responder=self.file_responder({"rows": ["节点🐍"] * 40_000}))
        self.assertEqual(out, "40000\n")
        self.assertEqual(sum(c["tool"] == "test.query" for c in calls), 1)
        self.assertGreater(sum(c["tool"] == "result.read" for c in calls), 1)

    def test_failed_transfer_keeps_old_file_and_removes_partial_file(self):
        out, _ = self.run_script('''from pathlib import Path
from siclaw import call_to_file
Path("data.json").write_text("old")
try:
    call_to_file("test.query", {}, "data.json")
    raise AssertionError("expected denial")
except RuntimeError:
    pass
assert Path("data.json").read_text() == "old"
assert not list(Path(".").glob(".siclaw-result-*"))
print("atomic-ok")
''', responder=self.file_responder({"text": "x" * 200_000}, broken=True))
        self.assertEqual(out, "atomic-ok\n")

    def test_checksum_mismatch_never_replaces_destination(self):
        respond = self.file_responder({"rows": ["safe"] * 40_000})
        def corrupt(call):
            value = respond(call)
            if call.get("delivery") == "file":
                value["result"]["sha256"] = "0" * 64
            return value
        out, calls = self.run_script('''from pathlib import Path
from siclaw import call_to_file
Path("data.json").write_text("old")
try:
    call_to_file("test.query", {}, "data.json")
    raise AssertionError("checksum mismatch accepted")
except RuntimeError as error:
    assert "checksum" in str(error)
assert Path("data.json").read_text() == "old"
assert not list(Path(".").glob(".siclaw-result-*"))
print("checksum-denied")
''', responder=corrupt)
        self.assertEqual(out, "checksum-denied\n")
        self.assertEqual(sum(c["tool"] == "test.query" for c in calls), 1)

    def test_shell_file_output_and_work_directory_constraint(self):
        sdk = str(Path(RUNNER).with_name("siclaw.py"))
        command = f'''"{sys.executable}" "{sdk}" --output data.json test.query '{{}}' > receipt.json
"{sys.executable}" -c 'import json; assert len(json.load(open("data.json"))["rows"])==40000; print("shell-file-ok")'
'''
        out, _ = self.run_script(command, language="shell", responder=self.file_responder({"rows": ["ok"] * 40_000}))
        self.assertEqual(out, "shell-file-ok\n")
        out, calls = self.run_script('''from siclaw import call_to_file
try:
    call_to_file("test.query", {}, "/tmp/outside-sandbox-data.json")
    raise AssertionError("outside path allowed")
except ValueError:
    print("path-denied")
''')
        self.assertEqual(out, "path-denied\n")
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()

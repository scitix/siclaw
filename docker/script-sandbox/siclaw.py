"""Small synchronous SDK shared by Python scripts and siclaw-tool.

The descriptors identify pipe endpoints, not credentials. All requests remain
untrusted and are authorized by the Runtime outside this container.
"""
import fcntl
import json
import os
import uuid
import base64
import hashlib
import tempfile
import time
import stat
from contextlib import contextmanager
from pathlib import Path

MAX_FRAME = 256 * 1024


class ToolError(RuntimeError):
    """A single tool failure; never automatically retry an uncertain execution."""
    def __init__(self, response):
        super().__init__(response["error"])
        self.code = response.get("code", "TOOL_UNAVAILABLE")
        self.execution = response.get("execution", "UNKNOWN")
        self.cleanup = response.get("cleanup", "not_required")
        self.retry_after_ms = response.get("retry_after_ms")
        self.result = response.get("result")


def _atomic_write(path, data):
    destination = Path(path)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, prefix=".rpc-write-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(data)
        directory_fd = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.replace(temporary.name, destination.name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        finally:
            os.close(directory_fd)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _read_message(path):
    # Never block on a task-created FIFO or follow a task-created symlink.
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise RuntimeError("Invalid SDK message file")
        data = stream.read(MAX_FRAME + 1)
    if len(data) > MAX_FRAME:
        raise RuntimeError("Tool message exceeds the frame limit")
    value = json.loads(data)
    if not isinstance(value, dict):
        raise RuntimeError("Invalid SDK message")
    return value


@contextmanager
def _lane():
    # Each lane has one atomic request/response mailbox. A published request
    # remains occupied until Runtime replies, even if its client is killed.
    # Locks coordinate both Python threads and independent Shell children.
    lanes = json.loads(os.environ["SICLAW_RPC_LANES"])
    if not isinstance(lanes, list) or not 1 <= len(lanes) <= 10:
        raise RuntimeError("Invalid SDK channels")
    start = int(uuid.uuid4().hex, 16) % len(lanes)
    while True:
        for index in range(len(lanes)):
            lane = lanes[(start + index) % len(lanes)]
            lock = open(lane["lock"], "a")
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                lock.close()
                continue
            try:
                if Path(lane["request"]).exists():
                    continue
                # The previous owner may have died. Its completed response must
                # never be read by the next transaction.
                Path(lane["response"]).unlink(missing_ok=True)
                yield lane
            finally:
                lock.close()
            return
        time.sleep(0.01)


def input_data():
    with open(os.environ["SICLAW_INPUT_FILE"], encoding="utf-8") as stream:
        return json.load(stream)


def call(tool, arguments=None):
    return _call(tool, arguments)


def _call(tool, arguments=None, delivery=None):
    request = {"id": uuid.uuid4().hex, "tool": tool, "arguments": arguments or {}}
    if delivery is not None:
        request["delivery"] = delivery
    data = (json.dumps(request, ensure_ascii=False) + "\n").encode()
    if len(data) > MAX_FRAME:
        raise ValueError("Tool request exceeds the frame limit")
    with _lane() as lane:
        _atomic_write(lane["request"], data)
        while True:
            try:
                result = _read_message(lane["response"])
                break
            except FileNotFoundError:
                time.sleep(0.005)
        Path(lane["response"]).unlink(missing_ok=True)
        if result.get("id") != request["id"]:
            raise RuntimeError("Tool response id mismatch")
        if "error" in result:
            raise ToolError(result)
        return result.get("result")


def call_to_file(tool, arguments, path):
    """Save a complete authorized JSON result atomically, without printing it.

    Paths stay in this run's work directory. The server receives no file path.
    Chunk reads never repeat the original tool operation and are not retried.
    """
    work = Path(os.environ["SICLAW_INPUT_FILE"]).parent.resolve()
    destination = Path(path).resolve()
    if not destination.is_relative_to(work) or destination == work:
        raise ValueError("Output must be inside the sandbox work directory")
    transfer_id = None
    temporary = None
    try:
        info = _call(tool, arguments, "file")
        if (not isinstance(info, dict) or info.get("encoding") != "json-utf8" or
                type(info.get("bytes")) is not int or not 0 < info["bytes"] <= 4 * 1024 * 1024 or
                not isinstance(info.get("sha256"), str) or len(info["sha256"]) != 64 or
                not isinstance(info.get("transfer_id"), str) or len(info["transfer_id"]) != 64):
            raise RuntimeError("Invalid file result")
        transfer_id = info["transfer_id"]
        offset = 0
        digest = hashlib.sha256()
        with tempfile.NamedTemporaryFile(dir=destination.parent, prefix=".siclaw-result-", delete=False) as stream:
            temporary = Path(stream.name)
            while True:
                chunk = _call("result.read", {"transfer_id": transfer_id, "offset": offset})
                if (not isinstance(chunk, dict) or not isinstance(chunk.get("data"), str) or
                        len(chunk["data"]) > 64 * 1024 or type(chunk.get("done")) is not bool):
                    raise RuntimeError("Invalid result chunk")
                data = base64.b64decode(chunk["data"], validate=True)
                offset += len(data)
                if (not data or offset > info["bytes"] or type(chunk.get("next_offset")) is not int or
                        chunk["next_offset"] != offset or chunk["done"] != (offset == info["bytes"])):
                    raise RuntimeError("Incomplete result transfer")
                stream.write(data)
                digest.update(data)
                if chunk["done"]:
                    break
            if digest.hexdigest() != info["sha256"]:
                raise RuntimeError("Result checksum mismatch")
            stream.flush()
            os.fsync(stream.fileno())
        # Use renameat explicitly; it is in the launcher's syscall allowlist.
        directory_fd = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.replace(temporary.name, destination.name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        finally:
            os.close(directory_fd)
        temporary = None
        return {"path": str(destination), "bytes": info["bytes"], "sha256": info["sha256"]}
    except BaseException:
        if transfer_id is not None:
            try:
                _call("result.discard", {"transfer_id": transfer_id})
            except Exception:
                pass
        raise
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    import sys
    args = sys.argv[1:]
    path = None
    if len(args) >= 2 and args[0] == "--output":
        path, args = args[1], args[2:]
    if len(args) not in (1, 2):
        raise SystemExit("Usage: siclaw-tool [--output WORK_FILE] TOOL [JSON_ARGUMENTS]")
    arguments = json.loads(args[1]) if len(args) == 2 else {}
    value = call_to_file(args[0], arguments, path) if path is not None else call(args[0], arguments)
    print(json.dumps(value, ensure_ascii=False))


if __name__ == "__main__":
    main()

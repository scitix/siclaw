"""Bounded KBC file tools shared by compiler and read-only Pi sessions.

The host supplies its existing workspace/source/snapshot guard. Every matching
search path is checked as well as the initial tool input; no unrestricted shell
or SDK filesystem tool is available to the model.
"""

from __future__ import annotations

import asyncio
import base64
import codecs
import mimetypes
import os
import re
import tempfile
from pathlib import Path
from typing import Awaitable, Callable

from agent_protocol import EngineTool

MAX_OUTPUT_BYTES = 32 * 1024
MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_MEDIA_BYTES = 20 * 1024 * 1024
MAX_PDF_PAGES = 20
MAX_PATH_LIST_BYTES = 8 * 1024 * 1024
PermissionGuard = Callable[[dict, object, object], Awaitable[dict]]


def text_result(text: str) -> dict:
    return {"content": [{"type": "text", "text": text}]}


async def _stop_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    try:
        process.terminate()
    except ProcessLookupError:
        await process.wait()
        return
    try:
        await asyncio.wait_for(process.wait(), 2)
    except asyncio.TimeoutError:
        try:
            process.kill()
        except ProcessLookupError:
            pass
        await process.wait()


async def _command(command: list[str], *, limit: int = MAX_OUTPUT_BYTES) -> tuple[int, str, bool]:
    """Bounded subprocess output and cancellation; never starts a shell."""
    process = await asyncio.create_subprocess_exec(
        *command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    output = bytearray()
    truncated = False
    try:
        async with asyncio.timeout(30):
            while block := await process.stdout.read(8192):
                remaining = limit - len(output)
                output.extend(block[:remaining])
                if len(block) > remaining:
                    truncated = True
                    await _stop_process(process)
                    break
            await process.wait()
    finally:
        await _stop_process(process)
        # A terminated command can leave buffered pipe bytes. Drain them so
        # the subprocess transport closes before the session's loop ends.
        while await process.stdout.read(8192):
            pass
    # Preserve complete UTF-8 characters when truncation falls inside a codepoint.
    decoder = codecs.getincrementaldecoder("utf-8")()
    return process.returncode, decoder.decode(bytes(output), final=not truncated), truncated


def _integer(args: dict, key: str, default: int, *, minimum: int = 0, maximum: int = 10_000) -> int:
    value = args.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"{key} must be an integer from {minimum} to {maximum}")
    return value


class FileTools:
    def __init__(self, cwd: str, allowed: list[str], guard: PermissionGuard):
        self.root = Path(cwd).resolve()
        self.allowed = set(allowed)
        self.guard = guard

    async def check(self, name: str, args: dict) -> None:
        if name not in self.allowed:
            raise PermissionError(f"Tool {name} is not enabled")
        decision = await self.guard({"tool_name": name, "tool_input": args}, None, None)
        hook = decision.get("hookSpecificOutput") or {}
        if hook.get("permissionDecision") == "deny":
            raise PermissionError(hook.get("permissionDecisionReason") or "Path is not allowed")

    def target(self, value: object) -> Path:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("file_path must be a non-empty string")
        target = Path(value)
        return (target if target.is_absolute() else self.root / target).resolve()

    async def read(self, args: dict) -> dict:
        await self.check("Read", args)
        target = self.target(args.get("file_path"))
        # Page-sliced compilation keeps the original large PDF in Raw. Bound
        # the requested pages and render output, not the whole source file.
        if target.suffix.lower() == ".pdf":
            return await self.read_pdf(target, args)
        if target.stat().st_size > MAX_FILE_BYTES:
            raise ValueError("File exceeds the direct-read budget; use a bounded source view")
        mime = mimetypes.guess_type(target.name)[0] or ""
        if mime in {"image/png", "image/jpeg", "image/gif", "image/webp"}:
            data = target.read_bytes()
            if len(data) > MAX_MEDIA_BYTES:
                raise ValueError("Image exceeds the media budget")
            return {"content": [{"type": "image", "mimeType": mime, "data": base64.b64encode(data).decode("ascii")}]}
        offset = _integer(args, "offset", 1, minimum=1, maximum=100_000_000)
        limit = _integer(args, "limit", 2000, minimum=1)
        lines = target.read_text(encoding="utf-8").splitlines()
        selected = lines[offset - 1:offset - 1 + limit]
        output = "\n".join(f"{index}\t{line}" for index, line in enumerate(selected, offset))
        encoded = output.encode("utf-8")
        truncated = len(encoded) > MAX_OUTPUT_BYTES or offset - 1 + limit < len(lines)
        decoder = codecs.getincrementaldecoder("utf-8")()
        output = decoder.decode(encoded[:MAX_OUTPUT_BYTES], final=not truncated)
        if truncated:
            output += "\n[Output truncated. Continue with offset/limit or the bounded source tools.]"
        return text_result(output)

    async def read_pdf(self, target: Path, args: dict) -> dict:
        status, info, _ = await _command(["pdfinfo", str(target)])
        match = re.search(r"^Pages:\s+(\d+)", info, re.M)
        if status or not match:
            raise ValueError("Could not inspect PDF pages")
        total = int(match.group(1))
        page_spec = args.get("pages")
        if page_spec is None:
            first, last = 1, min(total, MAX_PDF_PAGES)
        else:
            match = re.fullmatch(r"([1-9]\d*)(?:-([1-9]\d*))?", str(page_spec).strip())
            if not match:
                raise ValueError("pages must be one page or an inclusive range such as 1-5")
            first, last = int(match.group(1)), int(match.group(2) or match.group(1))
        if first > last or last > total or last - first + 1 > MAX_PDF_PAGES:
            raise ValueError(f"PDF page range must be within 1-{total} and contain at most {MAX_PDF_PAGES} pages")
        status, text, truncated = await _command([
            "pdftotext", "-enc", "UTF-8", "-f", str(first), "-l", str(last), str(target), "-",
        ])
        if status and not truncated:
            raise ValueError("Could not extract the selected PDF pages")
        content = [{"type": "text", "text": f"PDF pages {first}-{last} of {total}.\n{text}"}]
        with tempfile.TemporaryDirectory(prefix="kbc-pdf-") as temp:
            status, _, _ = await _command([
                "pdftoppm", "-f", str(first), "-l", str(last), "-scale-to", "1600", "-png", str(target), str(Path(temp) / "page"),
            ])
            if status:
                raise ValueError("Could not render the selected PDF pages")
            images = sorted(Path(temp).glob("page-*.png"), key=lambda image: int(image.stem.split("-")[-1]))
            if len(images) != last - first + 1:
                raise ValueError("PDF renderer returned an incomplete page range")
            if sum(image.stat().st_size for image in images) > MAX_MEDIA_BYTES:
                raise ValueError("Rendered PDF exceeds the media budget; request fewer pages")
            for image in images:
                content.append({"type": "image", "mimeType": "image/png", "data": base64.b64encode(image.read_bytes()).decode("ascii")})
        return {"content": content}

    async def write(self, args: dict) -> dict:
        await self.check("Write", args)
        target = self.target(args.get("file_path"))
        content = args.get("content")
        if not isinstance(content, str) or len(content.encode("utf-8")) > MAX_FILE_BYTES:
            raise ValueError("content must be text within the write budget")
        self._replace(target, content)
        return text_result(f"Wrote {len(content.encode('utf-8'))} bytes to {target}")

    async def edit(self, args: dict) -> dict:
        await self.check("Edit", args)
        target = self.target(args.get("file_path"))
        if target.stat().st_size > MAX_FILE_BYTES:
            raise ValueError("File exceeds the edit budget")
        old, new = args.get("old_string"), args.get("new_string")
        if not isinstance(old, str) or not old or not isinstance(new, str):
            raise ValueError("old_string must be non-empty text and new_string must be text")
        content = target.read_text(encoding="utf-8")
        count = content.count(old)
        if not count or (count != 1 and args.get("replace_all") is not True):
            raise ValueError(f"old_string matches {count} locations; provide a unique match or replace_all")
        result = content.replace(old, new, -1 if args.get("replace_all") is True else 1)
        if len(result.encode("utf-8")) > MAX_FILE_BYTES:
            raise ValueError("Edited file exceeds the write budget")
        self._replace(target, result)
        return text_result(f"Edited {target}")

    @staticmethod
    def _replace(target: Path, content: str) -> None:
        # No await/thread boundary between mutation and completion: cancellation
        # cannot leave an unjoined writer running behind the next attempt.
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor, name = tempfile.mkstemp(prefix=".kbc-write-", dir=target.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as file:
                file.write(content)
                file.flush()
                os.fsync(file.fileno())
            if target.exists():
                os.chmod(name, target.stat().st_mode & 0o777)
            os.replace(name, target)
        finally:
            Path(name).unlink(missing_ok=True)

    async def glob(self, args: dict) -> dict:
        await self.check("Glob", args)
        root = self.target(args.get("path") or str(self.root))
        pattern = args.get("pattern")
        if not isinstance(pattern, str) or not pattern:
            raise ValueError("pattern must be non-empty text")
        if Path(pattern).is_absolute():
            pattern = str(Path(pattern).relative_to(root))
        status, output, truncated = await _command(["rg", "--files", "--null", "--hidden", "--no-ignore", "-g", pattern, "--", str(root)])
        if status not in (0, 1) and not truncated:
            raise ValueError(f"Glob failed: {output[:1000]}")
        paths = []
        for value in output.split("\0")[:-1]:
            try:
                await self.check("Glob", {**args, "path": value})
            except PermissionError:
                continue
            paths.append(value)
        return text_result("\n".join(paths) + ("\n[Output truncated.]" if truncated else ""))

    async def grep(self, args: dict) -> dict:
        await self.check("Grep", args)
        root = self.target(args.get("path") or str(self.root))
        pattern = args.get("pattern")
        if not isinstance(pattern, str) or not pattern:
            raise ValueError("pattern must be non-empty text")
        # Enumerate first so denied descendants are excluded before content
        # search. The source guard intentionally permits bounded corpus grep
        # in consulting batches while denying broad strict-scope searches.
        enumerate_command = ["rg", "--files", "--null", "--hidden", "--no-ignore"]
        if args.get("glob"): enumerate_command.extend(["--glob", str(args["glob"])])
        if args.get("type"): enumerate_command.extend(["--type", str(args["type"])])
        single_file = not root.is_dir()
        if single_file:
            if not root.is_file():
                raise ValueError("Search path does not exist or is not a regular file")
            # rg bypasses glob/type filters for an explicitly named file. Walk
            # its immediate parent and keep only that file after filtering.
            enumerate_command.extend(["--max-depth", "1"])
        status, listing, listing_truncated = await _command(
            [*enumerate_command, "--", str(root.parent if single_file else root)], limit=MAX_PATH_LIST_BYTES,
        )
        if status not in (0, 1) and not listing_truncated:
            raise ValueError("Could not enumerate search paths")
        paths = []
        for value in listing.split("\0")[:-1]:
            if single_file and Path(value) != root:
                continue
            try:
                await self.check("Grep", {**args, "path": value})
            except PermissionError:
                continue
            paths.append(value)
        if not paths:
            return text_result("No matches.")
        mode = args.get("output_mode", "files_with_matches")
        if mode not in {"content", "files_with_matches", "count"}:
            raise ValueError("Invalid output_mode")
        command = ["rg", "--color", "never", "--no-heading", "--with-filename"]
        if mode == "files_with_matches": command.append("--files-with-matches")
        if mode == "count": command.append("--count")
        if mode == "content" and args.get("-n", True): command.append("--line-number")
        if args.get("-i"): command.append("--ignore-case")
        if args.get("multiline"): command.extend(["--multiline", "--multiline-dotall"])
        for key, flag in (("-A", "--after-context"), ("-B", "--before-context"), ("-C", "--context")):
            if key in args: command.extend([flag, str(_integer(args, key, 0, maximum=100))])
        if len(pattern.encode("utf-8")) > 16 * 1024:
            raise ValueError("Search pattern exceeds the regex budget")
        # Keep each argv below platform limits without cutting the corpus to
        # whichever paths happen to fit the first command.
        batches: list[list[str]] = [[]]
        argument_bytes = 0
        for value in paths:
            size = len(os.fsencode(value)) + 1
            if argument_bytes + size > 64 * 1024 and batches[-1]:
                batches.append([])
                argument_bytes = 0
            batches[-1].append(value)
            argument_bytes += size
        output = ""
        truncated = False
        async with asyncio.timeout(60):
            for batch in batches:
                remaining = MAX_OUTPUT_BYTES - len(output.encode("utf-8"))
                if remaining <= 0:
                    truncated = True
                    break
                status, chunk, cut = await _command([*command, "-e", pattern, "--", *batch], limit=remaining)
                if status not in (0, 1) and not cut:
                    raise ValueError(f"Grep failed: {chunk[:1000]}")
                output += chunk
                if cut:
                    truncated = True
                    break
        offset = _integer(args, "offset", 0)
        limit = _integer(args, "head_limit", 200, minimum=1)
        lines = output.splitlines()
        shown = "\n".join(lines[offset:offset + limit])
        if truncated or listing_truncated or offset + limit < len(lines):
            shown += "\n[Search output truncated; narrow path/pattern or use source_search.]"
        return text_result(shown or "No matches.")

    def tools(self) -> list[EngineTool]:
        string = {"type": "string"}
        integer = {"type": "integer"}
        boolean = {"type": "boolean"}
        definitions = [
            ("Read", "Read UTF-8 text with one-based offset/limit, an image, or selected PDF pages (e.g. pages=1-5). Output is bounded and reports truncation.",
             {"file_path": string, "offset": integer, "limit": integer, "pages": string}, ["file_path"], self.read),
            ("Write", "Atomically write UTF-8 text to an allowed workspace file.",
             {"file_path": string, "content": string}, ["file_path", "content"], self.write),
            ("Edit", "Replace an exact unique string, or every match with replace_all.",
             {"file_path": string, "old_string": string, "new_string": string, "replace_all": boolean}, ["file_path", "old_string", "new_string"], self.edit),
            ("Glob", "List allowed file paths matching a glob pattern, optionally under path.",
             {"pattern": string, "path": string}, ["pattern"], self.glob),
            ("Grep", "Search allowed file contents with ripgrep regex. Select content, files_with_matches (default), or count. Narrow truncated searches or use source_search.",
             {"pattern": string, "path": string, "glob": string, "type": string, "output_mode": {"type": "string", "enum": ["content", "files_with_matches", "count"]},
              "-i": boolean, "-n": boolean, "-A": integer, "-B": integer, "-C": integer, "multiline": boolean, "head_limit": integer, "offset": integer}, ["pattern"], self.grep),
        ]
        return [EngineTool(name, description, {"type": "object", "properties": properties, "required": required, "additionalProperties": False}, handler)
                for name, description, properties, required, handler in definitions if name in self.allowed]

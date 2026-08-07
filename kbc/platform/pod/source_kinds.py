"""Shared source classification for KBC planning, inspection, and provenance.

The document compiler historically carried separate extension lists in the
batch planner and self-check.  A code archive exposed the cost of that drift:
source files were readable UTF-8, but the planner priced them as binary and the
body-citation parser rejected their paths.  Keep one dependency-free registry
so every deterministic KBC layer agrees on what the model can inspect as text.
"""

from __future__ import annotations

from pathlib import Path, PurePosixPath


DOCUMENT_TEXT_EXTS = {
    ".md", ".mdx", ".txt", ".tsv", ".csv", ".json", ".jsonl",
    ".yaml", ".yml", ".xml", ".html", ".htm", ".rst",
}

CODE_TEXT_EXTS = {
    ".asm", ".bash", ".c", ".cc", ".cfg", ".cjs", ".cmake", ".conf",
    ".cpp", ".cs", ".css", ".dart", ".ex", ".exs", ".fish", ".go",
    ".gradle", ".graphql", ".gql", ".h", ".hcl", ".hpp", ".hrl", ".ini",
    ".ipynb", ".java", ".jl", ".js", ".jsx", ".kt", ".kts", ".less",
    ".lock", ".lua", ".mjs", ".mk", ".mod", ".php", ".pl", ".properties",
    ".proto", ".ps1", ".py", ".r", ".rb", ".rs", ".s", ".scala", ".scss",
    ".sh", ".sol", ".sql", ".sum", ".svelte", ".swift", ".tf", ".toml",
    ".tpl", ".ts", ".tsx", ".vue", ".work", ".zsh",
}

TEXT_SOURCE_EXTS = DOCUMENT_TEXT_EXTS | CODE_TEXT_EXTS

IMAGE_SOURCE_EXTS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg",
}
MEDIA_SOURCE_EXTS = IMAGE_SOURCE_EXTS | {
    ".pdf", ".ppt", ".pptx", ".doc", ".docx", ".xls", ".xlsx", ".tiff",
}
KNOWN_SOURCE_EXTS = TEXT_SOURCE_EXTS | MEDIA_SOURCE_EXTS

# Common source files whose semantic type lives in the basename rather than a
# conventional suffix.  Prefix matches cover image/build variants such as
# Dockerfile.agentbox and Makefile.release without treating arbitrary binaries
# as text.
TEXT_SOURCE_BASENAMES = {
    "brewfile", "gemfile", "jenkinsfile", "license", "notice", "procfile",
    "rakefile", "vagrantfile",
}
TEXT_SOURCE_PREFIXES = ("dockerfile", "makefile")

# A Git archive intentionally contains repository automation and build metadata
# below selected dot directories. Treating every hidden path as OS junk hides
# CI, release, and dev-container architecture from a code compiler. Keep the
# allowlist explicit so arbitrary hidden caches still stay out.
VISIBLE_HIDDEN_SOURCE_DIRS = {
    ".circleci", ".devcontainer", ".github", ".gitlab",
}
VISIBLE_HIDDEN_SOURCE_FILES = {
    ".bazelrc", ".buckconfig", ".dockerignore", ".editorconfig",
    ".env.example", ".env.sample", ".env.template", ".gitattributes",
    ".gitignore", ".gitlab-ci.yml", ".golangci.yml", ".goreleaser.yml",
    ".markdownlint.json", ".npmrc", ".nvmrc", ".pre-commit-config.yaml",
    ".yamllint.yml",
}


def is_text_source_path(path: str | Path | PurePosixPath) -> bool:
    value = PurePosixPath(str(path).replace("\\", "/"))
    name = value.name.casefold()
    if value.suffix.casefold() in TEXT_SOURCE_EXTS:
        return True
    if name in TEXT_SOURCE_BASENAMES:
        return True
    return any(name == prefix or name.startswith(prefix + ".")
               for prefix in TEXT_SOURCE_PREFIXES)


def is_known_source_path(path: str | Path | PurePosixPath) -> bool:
    value = PurePosixPath(str(path).replace("\\", "/"))
    return is_text_source_path(value) or value.suffix.casefold() in MEDIA_SOURCE_EXTS


def is_managed_source_path(path: str | Path | PurePosixPath) -> bool:
    """Whether a Raw path belongs in inventory, planning, and provenance.

    Normal source paths are included. Hidden directories are included only for
    known repository-control surfaces; hidden files only for explicit build and
    tooling metadata. This keeps Git architecture visible without re-admitting
    arbitrary caches and editor debris.
    """
    value = PurePosixPath(str(path).replace("\\", "/"))
    if any(
        part.startswith(".") and part.casefold() not in VISIBLE_HIDDEN_SOURCE_DIRS
        for part in value.parts[:-1]
    ):
        return False
    name = value.name.casefold()
    return not name.startswith(".") or name in VISIBLE_HIDDEN_SOURCE_FILES

"""Resolved compiler model contracts supplied by the control plane.

The worker never discovers a model, credential or role default. One box serves
one run; configuration is installed before its sessions start and copied into
each session so later environment changes cannot change an active execution.
"""

from copy import deepcopy
import json
from urllib.parse import urlsplit

_roles: dict[str, dict] = {}
_REQUIRED_ROLES = {"compile", "blue", "judge", "transcribe", "compare"}
_APIS = {"anthropic-messages", "openai-completions", "openai-responses"}
_THINKING_LEVELS = {"off", "minimal", "low", "medium", "high", "xhigh", "max"}


def configure(execution: object) -> None:
    global _roles
    if not isinstance(execution, dict) or execution.get("version") != 1:
        raise ValueError("Pi compilation requires execution configuration version 1")
    roles = execution.get("roles")
    if not isinstance(roles, dict) or not _REQUIRED_ROLES.issubset(roles):
        raise ValueError("Pi execution configuration is missing required model roles")
    for role, config in roles.items():
        if not isinstance(config, dict):
            raise ValueError(f"Invalid Pi model configuration for role {role}")
        model = config.get("model")
        if not isinstance(model, dict) or not all(isinstance(model.get(key), str) and model[key].strip()
                                                   for key in ("id", "name", "provider", "baseUrl")):
            raise ValueError(f"Incomplete Pi model descriptor for role {role}")
        url = urlsplit(model["baseUrl"])
        if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password:
            raise ValueError(f"Invalid Pi model endpoint for role {role}")
        if model.get("api") not in _APIS or model.get("input") not in (["text"], ["text", "image"]):
            raise ValueError(f"Unsupported Pi model protocol or inputs for role {role}")
        if not isinstance(model.get("reasoning"), bool) or not all(
            type(model.get(key)) is int and model[key] > 0 for key in ("contextWindow", "maxTokens")
        ):
            raise ValueError(f"Missing Pi model limits or reasoning capability for role {role}")
        if not isinstance(config.get("api_key"), str) or not config["api_key"].strip():
            raise ValueError(f"Missing Pi model credential for role {role}")
        if config.get("thinking_level", "off") not in _THINKING_LEVELS:
            raise ValueError(f"Invalid Pi thinking level for role {role}")
        if "auth_header" in config and not isinstance(config["auth_header"], bool):
            raise ValueError(f"Invalid Pi authentication mode for role {role}")
        headers = config.get("headers", {})
        if not isinstance(headers, dict) or any(not isinstance(key, str) or not key.strip() or
                                              (value is not None and not isinstance(value, str))
                                              for key, value in headers.items()):
            raise ValueError(f"Invalid Pi model headers for role {role}")
    _roles = deepcopy(roles)


def for_role(role: str, *, model: str | None = None, effort: str | None = None,
             session_kind: str = "verify") -> dict:
    if role not in _roles:
        raise ValueError(f"Pi model role {role} is not configured")
    config = deepcopy(_roles[role])
    config["role"] = role
    if model and config["model"]["id"] != model:
        raise ValueError(f"Pi model role {role} differs from the requested model; refresh its execution configuration")
    if effort is not None:
        if effort not in _THINKING_LEVELS:
            raise ValueError("Invalid Pi thinking level")
        config["thinking_level"] = effort
    if config["model"]["api"] == "anthropic-messages":
        import destream
        config["model"]["baseUrl"] = destream.session_endpoint(session_kind, config["model"]["baseUrl"])
    return config


def for_model(model: str, *, effort: str | None = None, session_kind: str = "verify") -> dict:
    matching = {role: config for role, config in _roles.items() if config["model"]["id"] == model}
    if not matching:
        raise ValueError("Requested Pi model is absent from the run's execution configuration")
    if len({json.dumps(config, sort_keys=True) for config in matching.values()}) != 1:
        raise ValueError("Requested Pi model has ambiguous role configuration; select an explicit role")
    return for_role(next(iter(matching)), model=model, effort=effort, session_kind=session_kind)


def role_model(role: str) -> str:
    return for_role(role, session_kind="test")["model"]["id"]

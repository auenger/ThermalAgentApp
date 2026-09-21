"""Serve newline-delimited JSON RPC requests over stdin/stdout."""

from __future__ import annotations

import json
import sys
from typing import Any

from . import PLUGIN_ID, PLUGIN_VERSION, PROTOCOL_VERSION
from .probe import probe_environment


def _success(request_id: str, result: object) -> dict[str, object]:
    return {"id": request_id, "ok": True, "result": result}


def _failure(request_id: str, code: str, message: str) -> dict[str, object]:
    return {"id": request_id, "ok": False, "error": {"code": code, "message": message}}


def handle_request(value: Any) -> dict[str, object]:
    """Validate and dispatch one plugin protocol request."""
    if not isinstance(value, dict):
        return _failure("", "INVALID_REQUEST", "request must be an object")
    request_id = value.get("id")
    method = value.get("method")
    if not isinstance(request_id, str) or not request_id:
        return _failure("", "INVALID_REQUEST", "id must be a non-empty string")
    if method == "health":
        return _success(
            request_id,
            {
                "pluginId": PLUGIN_ID,
                "pluginVersion": PLUGIN_VERSION,
                "protocolVersion": PROTOCOL_VERSION,
                "status": "ok",
            },
        )
    if method == "probe_environment":
        return _success(request_id, probe_environment())
    return _failure(request_id, "METHOD_NOT_FOUND", f"unsupported method: {method}")


def main() -> int:
    """Read requests until stdin closes and emit exactly one response per input line."""
    for raw_line in sys.stdin:
        if not raw_line.strip():
            continue
        try:
            request = json.loads(raw_line)
            response = handle_request(request)
        except json.JSONDecodeError:
            response = _failure("", "INVALID_JSON", "request is not valid JSON")
        except Exception as exc:  # plugin boundary must return a stable protocol error
            response = _failure("", "PLUGIN_ERROR", str(exc)[:500])
        print(json.dumps(response, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

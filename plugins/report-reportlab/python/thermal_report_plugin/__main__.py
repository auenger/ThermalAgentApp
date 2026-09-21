from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from .report import render_task_report


def _response(request_id: str, *, result: dict[str, Any] | None = None, error: Exception | None = None) -> dict[str, Any]:
    if error is None:
        return {"id": request_id, "ok": True, "result": result or {}}
    return {
        "id": request_id,
        "ok": False,
        "error": {"code": type(error).__name__.upper(), "message": str(error)},
    }


def main() -> None:
    for raw_line in sys.stdin:
        try:
            request = json.loads(raw_line)
            request_id = str(request.get("id", ""))
            if request.get("method") != "render_task_report":
                raise ValueError(f"unsupported method: {request.get('method')}")
            params = request.get("params")
            if not isinstance(params, dict):
                raise ValueError("params must be an object")
            output_path = Path(str(params.get("outputPath", ""))).expanduser().resolve()
            if output_path.suffix.lower() != ".pdf":
                raise ValueError("outputPath must end with .pdf")
            output_path.parent.mkdir(parents=True, exist_ok=True)
            metadata = render_task_report(params, output_path)
            print(json.dumps(_response(request_id, result=metadata), ensure_ascii=False), flush=True)
        except Exception as exc:  # the JSON-RPC boundary must always return one response
            request_id = str(locals().get("request", {}).get("id", ""))
            print(json.dumps(_response(request_id, error=exc), ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()

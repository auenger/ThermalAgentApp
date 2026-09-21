"""Serve newline-delimited JSON RPC requests over stdin/stdout."""

from __future__ import annotations

import json
import sys
from typing import Any

from . import PLUGIN_ID, PLUGIN_VERSION, PROTOCOL_VERSION
from .probe import probe_environment
from .project import run_project_operation


def _success(request_id: str, result: object) -> dict[str, object]:
    return {"id": request_id, "ok": True, "result": result}


def _failure(request_id: str, code: str, message: str) -> dict[str, object]:
    return {"id": request_id, "ok": False, "error": {"code": code, "message": message}}


def _project_params(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("params must be an object")
    project_path = value.get("projectPath")
    output_dir = value.get("outputDir")
    if not isinstance(project_path, str) or not project_path.strip():
        raise ValueError("projectPath must be a non-empty string")
    if not isinstance(output_dir, str) or not output_dir.strip():
        raise ValueError("outputDir must be a non-empty string")
    profile = value.get("expectedProfile")
    if profile is not None and not isinstance(profile, dict):
        raise ValueError("expectedProfile must be an object")
    return {
        "source_project": project_path,
        "output_dir": output_dir,
        "version": str(value.get("version") or "2024.2"),
        "design": value.get("design") if isinstance(value.get("design"), str) else None,
        "setup": value.get("setup") if isinstance(value.get("setup"), str) else None,
        "cores": int(value["cores"]) if isinstance(value.get("cores"), int) and not isinstance(value.get("cores"), bool) else None,
        "non_graphical": value.get("nonGraphical") is not False,
        "expected_profile": profile,
        "flow_convergence_criterion": (
            float(value["flowConvergenceCriterion"])
            if isinstance(value.get("flowConvergenceCriterion"), (int, float))
            and not isinstance(value.get("flowConvergenceCriterion"), bool)
            else None
        ),
        "baseline_metrics": value.get("baselineMetrics") if isinstance(value.get("baselineMetrics"), dict) else None,
        "min_improvement_c": float(value.get("minImprovementC", 0.5)),
    }


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
    if method in {"inspect_project", "fan_check", "solve_project", "fan_solve"}:
        try:
            params = _project_params(value.get("params"))
            params["mode"] = {
                "inspect_project": "inspect",
                "fan_check": "fan-check",
                "solve_project": "solve",
                "fan_solve": "fan-solve",
            }[method]
            if method in {"fan_check", "fan_solve"}:
                params["fan_speed_ratio"] = value["params"].get("fanSpeedRatio", 1.1)
            return _success(request_id, run_project_operation(**params))
        except Exception as exc:
            return _failure(request_id, type(exc).__name__.upper(), str(exc)[:500])
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
            request_id = request.get("id", "") if isinstance(request, dict) else ""
            response = _failure(str(request_id), type(exc).__name__.upper(), str(exc)[:500])
        print(json.dumps(response, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Parse deterministic convergence evidence emitted by the Icepak solver."""

from __future__ import annotations

import math
import re
import hashlib
import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any


_FLOAT = r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?"
_RESIDUAL_HEADER = re.compile(
    r"^\s*iter\s+continuity\s+x-velocity\s+y-velocity\s+z-velocity\s+energy\s+time/iter\s*$",
    re.IGNORECASE,
)
_RESIDUAL_ROW = re.compile(
    rf"^\s*(\d+)\s+({_FLOAT})\s+({_FLOAT})\s+({_FLOAT})\s+({_FLOAT})\s+({_FLOAT})"
    r"\s+\d+:\d+:\d+(?:\s+\d+)?\s*$"
)
_REVERSED_FLOW = re.compile(
    r"^\s*Reversed flow on (\d+) face(?:s)? \(([0-9]+(?:\.[0-9]+)?)% area\) of (.+?)\.\s*$",
    re.IGNORECASE,
)
_SETUP_BLOCK = re.compile(r"\$begin 'Setup'(?P<body>.*?)\$end 'Setup'", re.DOTALL)
_NATIVE_TEMPERATURE_ROW = re.compile(rf"^\s*({_FLOAT})\s+Temperature\(({_FLOAT})\)\s*$")


def _monitor_histories(value: Any) -> dict[str, list[float]]:
    histories: dict[str, list[float]] = {}
    if not isinstance(value, Mapping):
        return histories
    for monitor_name, monitor_value in value.items():
        if not isinstance(monitor_value, Mapping):
            continue
        for quantity, raw_values in monitor_value.items():
            if "temperature" not in str(quantity).lower():
                continue
            if isinstance(raw_values, Sequence) and not isinstance(raw_values, (str, bytes, bytearray)):
                try:
                    histories[str(monitor_name)] = [float(item) for item in raw_values]
                except (TypeError, ValueError):
                    pass
                break
    return histories


def evaluate_monitor_stability(monitor_data: Any) -> dict[str, Any]:
    deltas: dict[str, float] = {}
    for name, values in _monitor_histories(monitor_data).items():
        if len(values) < 10:
            return {"verified": False, "reason": "insufficient_monitor_history", "last10MonitorDeltaC": deltas}
        window = values[-10:]
        if not all(math.isfinite(value) for value in window):
            return {"verified": False, "reason": "invalid_monitor_history", "last10MonitorDeltaC": deltas}
        deltas[name] = round(max(window) - min(window), 6)
    if not deltas:
        return {"verified": False, "reason": "insufficient_monitor_history", "last10MonitorDeltaC": {}}
    if any(delta > 0.5 for delta in deltas.values()):
        return {"verified": False, "reason": "monitor_delta_exceeds_0.5c", "last10MonitorDeltaC": deltas}
    return {"verified": True, "reason": "stable", "last10MonitorDeltaC": deltas}


def _setting_value(body: str, name: str) -> str:
    match = re.search(rf"^\s*'{re.escape(name)}'\s*=\s*'?([^'\r\n]+)'?\s*$", body, re.MULTILINE)
    if not match:
        raise ValueError(f"native iteration evidence is missing {name}")
    return match.group(1).strip()


def _setting_bool(body: str, name: str) -> bool:
    value = _setting_value(body, name).lower()
    if value not in {"true", "false"}:
        raise ValueError(f"native iteration evidence has invalid {name}")
    return value == "true"


def _setting_float(body: str, name: str) -> float:
    value = float(_setting_value(body, name))
    if not math.isfinite(value) or value < 0:
        raise ValueError(f"native iteration evidence has invalid {name}")
    return value


def _setting_int(body: str, name: str) -> int:
    value = int(_setting_value(body, name))
    if value <= 0:
        raise ValueError(f"native iteration evidence has invalid {name}")
    return value


def _parse_setup(text: str) -> dict[str, Any]:
    matches = list(_SETUP_BLOCK.finditer(text))
    if len(matches) != 1:
        raise ValueError("native iteration evidence must contain exactly one Setup block")
    body = matches[0].group("body")
    return {
        "includeFlow": _setting_bool(body, "Include Flow"),
        "includeTemperature": _setting_bool(body, "Include Temperature"),
        "flowCriterion": _setting_float(body, "Convergence Criteria - Flow"),
        "energyCriterion": _setting_float(body, "Convergence Criteria - Energy"),
        "maximumIterations": _setting_int(body, "Convergence Criteria - Max Iterations"),
    }


def _parse_final_residuals(text: str) -> tuple[dict[str, float], int]:
    rows: list[tuple[int, dict[str, float]]] = []
    saw_header = False
    names = ("continuity", "xVelocity", "yVelocity", "zVelocity", "energy")
    for line in text.splitlines():
        if _RESIDUAL_HEADER.match(line):
            saw_header = True
            continue
        if not saw_header:
            continue
        match = _RESIDUAL_ROW.match(line)
        if not match:
            continue
        iteration = int(match.group(1))
        values = [float(match.group(index)) for index in range(2, 7)]
        if any(not math.isfinite(value) or value < 0 for value in values):
            raise ValueError("native solver residuals contain invalid values")
        if rows and iteration < rows[-1][0]:
            raise ValueError("native solver iteration sequence moved backwards")
        rows.append((iteration, dict(zip(names, values))))
    if not rows:
        raise ValueError("native solver output has no residual table rows")
    return rows[-1][1], rows[-1][0]


def _parse_reversed_flow(text: str) -> dict[str, Any]:
    outlets: dict[str, dict[str, Any]] = {}
    occurrences = 0
    for line in text.splitlines():
        match = _REVERSED_FLOW.match(line)
        if not match:
            continue
        occurrences += 1
        name = match.group(3).removeprefix("pressure-outlet ")
        outlets[name] = {"faces": int(match.group(1)), "areaPercent": float(match.group(2))}
    return {"detected": bool(outlets), "occurrenceCount": occurrences, "outlets": outlets}


def parse_native_solver_evidence(
    *,
    iteration_text: str,
    solver_output_text: str,
    profile_text: str,
    monitor_data: Any,
) -> dict[str, Any]:
    setup = _parse_setup(iteration_text)
    residuals, actual_iterations = _parse_final_residuals(solver_output_text)
    flow_converged = setup["includeFlow"] and all(
        residuals[name] <= setup["flowCriterion"]
        for name in ("continuity", "xVelocity", "yVelocity", "zVelocity")
    )
    temperature_converged = setup["includeTemperature"] and residuals["energy"] <= setup["energyCriterion"]
    monitor = evaluate_monitor_stability(monitor_data)
    verified = flow_converged and temperature_converged and monitor["verified"]
    if not flow_converged:
        reason = "flow_not_converged"
    elif not temperature_converged:
        reason = "temperature_not_converged"
    elif not monitor["verified"]:
        reason = monitor["reason"]
    else:
        reason = "converged"
    termination = (
        "converged" if flow_converged and temperature_converged
        else "max_iterations" if actual_iterations >= setup["maximumIterations"]
        else "solver_completed_without_convergence"
    )
    return {
        "verified": verified,
        "reason": reason,
        "flowConverged": flow_converged,
        "temperatureConverged": temperature_converged,
        "temperatureConvergenceBasis": "energy_residual",
        "monitorTemperatureStable": monitor["verified"],
        "last10MonitorDeltaC": monitor["last10MonitorDeltaC"],
        "actualIterations": actual_iterations,
        "maximumIterations": setup["maximumIterations"],
        "terminationReason": termination,
        "terminationReasonInferred": True,
        "criteria": {"flow": setup["flowCriterion"], "energy": setup["energyCriterion"]},
        "finalResiduals": residuals,
        "reversedFlow": _parse_reversed_flow(solver_output_text),
        "solverNormalCompletion": "Normal Completion" in profile_text,
    }


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_json_safe(item) for item in value]
    return str(value)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _capture_monitor_data(ipk: Any) -> tuple[Any, str | None]:
    try:
        value = ipk.get_monitor_data()
    except Exception as exc:
        return None, f"{type(exc).__name__}: {exc}"
    normalized = _json_safe(value)
    if not _monitor_histories(normalized):
        return None, "monitor API returned no temperature history"
    return normalized, None


def _capture_exported_convergence(ipk: Any, output_dir: Path, setup: str) -> tuple[str | None, str | None]:
    requested = output_dir / "pyaedt-export.prop"
    try:
        exported = ipk.export_convergence(setup, output_file=str(requested))
    except Exception as exc:
        return None, f"{type(exc).__name__}: {exc}"
    path = Path(exported).expanduser().resolve() if isinstance(exported, (str, Path)) else requested
    try:
        if not path.is_file() or path.stat().st_size == 0:
            return None, "export_convergence returned no non-empty file"
        return path.read_text(encoding="utf-8-sig", errors="replace"), None
    except OSError as exc:
        return None, f"{type(exc).__name__}: {exc}"


def _temperature_monitor_ids(ipk: Any) -> dict[str, int]:
    try:
        raw = ipk.design_properties["Monitor"]["IcepakMonitors"]
    except (AttributeError, KeyError, TypeError):
        return {}
    if not isinstance(raw, Mapping):
        return {}
    result: dict[str, int] = {}
    for name, properties in raw.items():
        if not isinstance(properties, Mapping):
            continue
        quantities = properties.get("Quantities", [])
        if not isinstance(quantities, Sequence) or isinstance(quantities, (str, bytes, bytearray)):
            quantities = [quantities]
        monitor_id = properties.get("ID")
        if 19 in quantities and isinstance(monitor_id, int) and not isinstance(monitor_id, bool) and monitor_id >= 0:
            result[str(name)] = monitor_id
    return result


def _native_solver_files(artifact_project: Path, monitor_ids: Mapping[str, int]) -> tuple[dict[str, Path], str | None]:
    results_dir = artifact_project.with_suffix(".aedtresults")
    if not results_dir.is_dir():
        return {}, f"native results directory is missing: {results_dir}"
    pairs: list[tuple[int, Path, Path]] = []
    for output in results_dir.rglob("current.uns_out"):
        iteration = output.with_name("current.iter")
        if output.stat().st_size > 0 and iteration.is_file() and iteration.stat().st_size > 0:
            pairs.append((output.stat().st_mtime_ns, output, iteration))
    if not pairs:
        return {}, "no paired current.uns_out/current.iter files found"
    pairs.sort(key=lambda row: row[0], reverse=True)
    if len(pairs) > 1 and pairs[0][0] == pairs[1][0]:
        return {}, "multiple native solver result pairs have the same latest timestamp"
    _, output, iteration = pairs[0]
    paths = {"current.uns_out": output, "current.iter": iteration}
    profiles = [path for path in results_dir.rglob("*.profile") if path.stat().st_size > 0]
    if profiles:
        paths["solution.profile"] = max(profiles, key=lambda path: path.stat().st_mtime_ns)
    restart_match = re.fullmatch(r"(?P<prefix>.+)_V(?P<variant>\d+)\.restart", output.parent.name)
    if restart_match:
        prefix = restart_match.group("prefix")
        variant = restart_match.group("variant")
        for monitor_id in sorted(set(monitor_ids.values())):
            monitor_path = output.parent.parent / f"{prefix}_MON{monitor_id}_V{variant}.sd"
            if monitor_path.is_file() and monitor_path.stat().st_size > 0:
                paths[f"monitor-{monitor_id}.sd"] = monitor_path
    return paths, None


def _parse_native_temperature_history(text: str) -> list[float]:
    rows: list[tuple[float, float]] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        match = _NATIVE_TEMPERATURE_ROW.fullmatch(line)
        if not match:
            raise ValueError("unexpected native temperature monitor row")
        iteration, temperature = float(match.group(1)), float(match.group(2))
        if not math.isfinite(iteration) or iteration < 0 or not math.isfinite(temperature):
            raise ValueError("invalid native temperature monitor value")
        if rows and iteration <= rows[-1][0]:
            raise ValueError("native temperature monitor iterations are not increasing")
        rows.append((iteration, temperature))
    if not rows:
        raise ValueError("native temperature history is empty")
    return [temperature for _, temperature in rows]


def _native_temperature_histories(
    raw_files: Mapping[str, str], monitor_ids: Mapping[str, int]
) -> tuple[dict[str, dict[str, list[float]]] | None, str | None]:
    if not monitor_ids:
        return None, "AEDT design contains no temperature monitor IDs"
    result: dict[str, dict[str, list[float]]] = {}
    missing: list[str] = []
    for name, monitor_id in monitor_ids.items():
        text = raw_files.get(f"monitor-{monitor_id}.sd")
        if text is None:
            missing.append(name)
            continue
        try:
            result[name] = {"Temperature": _parse_native_temperature_history(text)}
        except ValueError as exc:
            return None, f"native temperature monitor {name} is invalid: {exc}"
    if missing:
        return None, f"native temperature monitor files are missing: {', '.join(sorted(missing))}"
    return result, None


def _exported_evidence(text: str, monitor_data: Any) -> dict[str, Any]:
    flow = bool(re.search(r"\bFlow\s*=\s*Converged\b", text, re.IGNORECASE))
    temperature = bool(re.search(r"\bTemperature\s*=\s*Converged\b", text, re.IGNORECASE))
    monitor = evaluate_monitor_stability(monitor_data)
    verified = flow and temperature and monitor["verified"]
    reason = (
        "converged" if verified else "flow_not_converged" if not flow
        else "temperature_not_converged" if not temperature else monitor["reason"]
    )
    return {
        "verified": verified,
        "reason": reason,
        "flowConverged": flow,
        "temperatureConverged": temperature,
        "temperatureConvergenceBasis": "pyaedt_export",
        "monitorTemperatureStable": monitor["verified"],
        "last10MonitorDeltaC": monitor["last10MonitorDeltaC"],
        "terminationReason": "converged" if flow and temperature else "unknown",
        "reversedFlow": {"detected": False, "occurrenceCount": 0, "outlets": {}},
        "solverNormalCompletion": None,
    }


def collect_convergence_evidence(
    ipk: Any,
    *,
    artifact_project: Path,
    output_dir: Path,
    setup: str,
    requested_flow_criterion: float | None = None,
) -> dict[str, Any]:
    api_monitor_data, monitor_error = _capture_monitor_data(ipk)
    monitor_ids = _temperature_monitor_ids(ipk)
    exported_text, export_error = _capture_exported_convergence(ipk, output_dir, setup)
    try:
        native_paths, native_error = _native_solver_files(artifact_project, monitor_ids)
    except OSError as exc:
        native_paths, native_error = {}, f"{type(exc).__name__}: {exc}"
    raw_files: dict[str, str] = {}
    evidence: dict[str, Any] | None = None
    monitor_data = api_monitor_data
    if native_paths:
        try:
            raw_files = {name: path.read_text(encoding="utf-8-sig", errors="replace") for name, path in native_paths.items()}
            native_monitors, native_monitor_error = _native_temperature_histories(raw_files, monitor_ids)
            if native_monitors is not None:
                monitor_data, monitor_error = native_monitors, None
            elif monitor_data is None:
                monitor_error = native_monitor_error
            evidence = parse_native_solver_evidence(
                iteration_text=raw_files["current.iter"],
                solver_output_text=raw_files["current.uns_out"],
                profile_text=raw_files.get("solution.profile", ""),
                monitor_data=monitor_data,
            )
            evidence.update({"source": "icepak_native_solver_files", "exportError": export_error, "monitorError": monitor_error})
        except (OSError, ValueError) as exc:
            native_error = f"{type(exc).__name__}: {exc}"
            evidence = None
    if evidence is None:
        if exported_text is None:
            raise RuntimeError(
                "solver_convergence_evidence_failed: neither PyAEDT export nor native Icepak evidence is usable; "
                f"export_error={export_error or 'missing'}; native_error={native_error or 'missing'}"
            )
        evidence = _exported_evidence(exported_text, monitor_data)
        evidence.update({"source": "pyaedt_export", "exportError": export_error, "nativeError": native_error, "monitorError": monitor_error})

    effective = float(evidence["criteria"]["flow"]) if evidence.get("source") == "icepak_native_solver_files" else None
    evidence["flowCriterionConfiguration"] = {
        "requested": requested_flow_criterion,
        "effective": effective,
        "source": "customer_config" if requested_flow_criterion is not None else "project_setting",
    }
    bundle = {
        "schemaVersion": "icepak-convergence-v1",
        "setup": setup,
        "evidence": evidence,
        "rawFileSha256": {name: _sha256_file(path) for name, path in native_paths.items()},
        "nativeEvidencePaths": {name: str(path) for name, path in native_paths.items()},
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    bundle_path = output_dir / "convergence.json"
    bundle_path.write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding="utf-8")
    if requested_flow_criterion is not None:
        if effective is None:
            raise RuntimeError("solver_flow_criterion_configuration_failed: native current.iter is required to verify the effective criterion")
        if not math.isclose(requested_flow_criterion, effective, rel_tol=0.0, abs_tol=1e-12):
            raise RuntimeError(
                f"solver_flow_criterion_configuration_failed: requested={requested_flow_criterion} effective={effective}"
            )
    return {
        "convergencePath": str(bundle_path),
        "convergenceEvidence": evidence,
        "convergenceEvidenceSource": evidence["source"],
        "monitorData": monitor_data if monitor_error is None else {"error": monitor_error},
        "nativeEvidencePaths": {name: str(path) for name, path in native_paths.items()},
    }

"""Standalone Icepak project inspection and safe mutation operations.

This module is intentionally independent from the legacy gateway, Temporal,
PostgreSQL, and object storage.  It is the Windows plugin boundary used by the
desktop application's local Core.
"""

from __future__ import annotations

import hashlib
import math
import os
import re
import shutil
import time
from collections.abc import Callable, Mapping
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

from .convergence import collect_convergence_evidence
from .metrics import collect_temperature_metrics, compare_temperature_metrics


IcepakFactory = Callable[..., Any]
ProgressCallback = Callable[[str], None]
_AEDT_START_LOCK = Lock()
_SECRET_ENVIRONMENT_KEYS = (
    "ANTHROPIC_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENAI_API_KEY",
)


def _report(progress: ProgressCallback | None, stage: str) -> None:
    if progress is not None:
        progress(stage)


@contextmanager
def _without_agent_secrets():
    hidden = {key: os.environ.pop(key) for key in _SECRET_ENVIRONMENT_KEYS if key in os.environ}
    try:
        yield
    finally:
        os.environ.update(hidden)


def _default_icepak_factory(*, progress: ProgressCallback | None = None, **kwargs: Any) -> Any:
    _report(progress, "pyaedt_importing")
    try:
        from ansys.aedt.core import Icepak
    except ImportError as exc:
        raise RuntimeError("PyAEDT is unavailable; install the Icepak plugin dependencies") from exc
    _report(progress, "aedt_starting")
    return Icepak(**kwargs)


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    return str(value)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _normalize_aedt_version(value: Any) -> str:
    text = str(value or "").strip().lower().replace(" ", "")
    match = re.fullmatch(r"ansysem_root(\d{3})", text)
    if match:
        raw = match.group(1)
        return f"20{raw[:2]}.{raw[2:]}"
    match = re.fullmatch(r"(20\d{2})(?:r|\.)(\d)", text)
    if match:
        return f"{match.group(1)}.{match.group(2)}"
    return text


def _project_metadata(ipk: Any) -> dict[str, Any]:
    boundaries = [
        {
            "name": str(item.name),
            "type": str(getattr(item, "type", "")),
            "properties": _json_safe(getattr(item, "props", {})),
        }
        for item in getattr(ipk, "boundaries", [])
    ]
    native_components = [
        {
            "name": str(getattr(item, "name", name)),
            "type": str(getattr(item, "type", "")),
            "properties": _json_safe(getattr(item, "props", {})),
        }
        for name, item in getattr(ipk, "native_components", {}).items()
    ]
    monitor = getattr(ipk, "monitor", None)
    monitors = sorted(str(name) for name in getattr(monitor, "all_monitors", {}))
    desktop = getattr(ipk, "desktop_class", None)
    version = getattr(ipk, "aedt_version_id", None) or getattr(desktop, "aedt_version_id", None)
    modeler = getattr(ipk, "modeler", None)
    return {
        "name": str(getattr(ipk, "project_name", "")),
        "aedtVersion": str(version or ""),
        "activeDesign": str(getattr(ipk, "design_name", "")),
        "designs": [str(name) for name in getattr(ipk, "design_list", [])],
        "setups": [str(name) for name in getattr(ipk, "setup_names", [])],
        "boundaries": boundaries,
        "nativeComponents": native_components,
        "monitors": monitors,
        "objects": [str(name) for name in getattr(modeler, "object_names", [])],
    }


def validate_fan_speed_ratio(value: Any) -> float:
    try:
        ratio = float(value)
    except (TypeError, ValueError):
        raise ValueError("fan speed ratio must be numeric") from None
    if not math.isfinite(ratio):
        raise ValueError("fan speed ratio must be finite")
    if ratio <= 1.0 or ratio > 1.5:
        raise ValueError("fan speed ratio must be greater than 1.0 and at most 1.5")
    return ratio


def _fan_provider(component: Any) -> Mapping[str, Any]:
    provider = getattr(component, "native_properties", None)
    if provider is None:
        provider = getattr(component, "props", {}).get("NativeComponentDefinitionProvider", {})
    return provider


def _scale_values(values: list[Any], factor: float) -> list[str]:
    return [format(float(value) * factor, ".12g") for value in values]


def apply_fan_speed_ratio(ipk: Any, value: Any) -> dict[str, Any]:
    """Scale every native curve fan using the fan similarity laws and verify read-back."""
    ratio = validate_fan_speed_ratio(value)
    fans: list[dict[str, Any]] = []
    for name, component in getattr(ipk, "native_components", {}).items():
        provider = _fan_provider(component)
        if provider.get("Type") != "Fan" or provider.get("FlowType") != "Curve":
            continue
        before_x = [str(item) for item in provider.get("X", [])]
        before_y = [str(item) for item in provider.get("Y", [])]
        if not before_x or not before_y:
            raise ValueError(f"fan curve is missing X or Y values: {name}")
        expected = {
            "X": _scale_values(before_x, ratio),
            "Y": _scale_values(before_y, ratio**2),
        }
        original_auto_update = getattr(component, "auto_update", None)
        if original_auto_update is not None:
            component.auto_update = False
        try:
            provider["X"] = expected["X"]
            provider["Y"] = expected["Y"]
            if component.update() is False:
                raise RuntimeError(f"failed to update native fan: {name}")
        finally:
            if original_auto_update is not None:
                component.auto_update = original_auto_update
        verified_provider = _fan_provider(component)
        verified = {
            "X": [str(item) for item in verified_provider.get("X", [])],
            "Y": [str(item) for item in verified_provider.get("Y", [])],
        }
        if verified != expected:
            raise RuntimeError(f"fan curve verification failed: {name}")
        fans.append(
            {
                "name": str(getattr(component, "name", name)),
                "before": {"X": before_x, "Y": before_y},
                "after": expected,
                "verifiedAfter": verified,
                "updated": True,
            }
        )
    if not fans:
        raise ValueError("no curve-based native fans found")
    return {
        "type": "fan_curve_speed_ratio",
        "target": "ALL_CURVE_FANS",
        "speedRatio": ratio,
        "verified": True,
        "fans": fans,
    }


def _has_curve_fan(project: Mapping[str, Any]) -> bool:
    for component in project.get("nativeComponents") or []:
        if not isinstance(component, Mapping):
            continue
        properties = component.get("properties")
        provider = properties.get("NativeComponentDefinitionProvider") if isinstance(properties, Mapping) else None
        if isinstance(provider, Mapping) and provider.get("Type") == "Fan" and provider.get("FlowType") == "Curve":
            return True
    return False


def _temperature_c(value: Any, label: str) -> float:
    match = re.fullmatch(
        r"\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([^\s]*)\s*",
        str(value or ""),
    )
    if not match:
        raise ValueError(f"{label} is missing a numeric temperature")
    number = float(match.group(1))
    unit = match.group(2).lower()
    if not math.isfinite(number):
        raise ValueError(f"{label} must be finite")
    if unit in {"", "c", "cel", "degc", "°c"}:
        return number
    if unit in {"k", "kel", "kelvin"}:
        return number - 273.15
    raise ValueError(f"{label} has unsupported temperature unit: {unit}")


def validate_project_profile(project: Mapping[str, Any], profile: Mapping[str, Any] | None) -> dict[str, Any]:
    if not profile:
        return {"verified": True, "checks": []}
    checks: list[str] = []
    expected_project = profile.get("project")
    if expected_project and str(project.get("name") or "") != str(expected_project):
        raise ValueError("capability profile project identity mismatch")
    if expected_project:
        checks.append("project")
    expected_design = profile.get("design")
    if expected_design and str(project.get("activeDesign") or "") != str(expected_design):
        raise ValueError("capability profile active design mismatch")
    if expected_design:
        checks.append("design")
    expected_setup = profile.get("setup")
    if expected_setup and str(expected_setup) not in [str(item) for item in project.get("setups") or []]:
        raise ValueError("capability profile setup mismatch")
    if expected_setup:
        checks.append("setup")
    expected_version = profile.get("aedtVersion")
    if expected_version and _normalize_aedt_version(project.get("aedtVersion")) != _normalize_aedt_version(expected_version):
        raise ValueError("capability profile AEDT version mismatch")
    if expected_version:
        checks.append("aedtVersion")
    actions = profile.get("actions") or []
    requires_curve_fan = any(
        isinstance(action, Mapping)
        and action.get("type") == "fan_curve_speed_ratio"
        and action.get("target", "ALL_CURVE_FANS") == "ALL_CURVE_FANS"
        for action in actions
    )
    if requires_curve_fan and not _has_curve_fan(project):
        raise ValueError("capability profile curve fan target not found")
    if requires_curve_fan:
        checks.append("curveFans")
    operation_flow = profile.get("operationFlow")
    if isinstance(operation_flow, Mapping) and "ambientTemperatureC" in operation_flow:
        expected_ambient = float(operation_flow["ambientTemperatureC"])
        openings: dict[str, float] = {}
        for boundary in project.get("boundaries") or []:
            if not isinstance(boundary, Mapping) or str(boundary.get("type") or "").lower() != "opening":
                continue
            properties = boundary.get("properties")
            if not isinstance(properties, Mapping) or "Temperature" not in properties:
                raise ValueError(f"opening {boundary.get('name')} has no Temperature")
            name = str(boundary.get("name") or "")
            openings[name] = _temperature_c(properties["Temperature"], f"opening {name} Temperature")
        if not openings or any(not math.isclose(value, expected_ambient, abs_tol=1e-9) for value in openings.values()):
            raise ValueError(f"capability profile ambient mismatch: expected {expected_ambient:g}C")
        checks.append("ambientTemperature")
    return {"verified": True, "checks": checks}


def _validate_source(source: Path, profile: Mapping[str, Any] | None) -> None:
    if not source.is_file():
        raise FileNotFoundError(f"Icepak project not found: {source}")
    if source.suffix.lower() != ".aedt":
        raise ValueError(f"expected an .aedt project, got: {source.name}")
    artifact = profile.get("artifact") if profile else None
    if not isinstance(artifact, Mapping):
        return
    filename = artifact.get("filename")
    if filename and source.name != str(filename):
        raise ValueError(f"capability artifact mismatch: expected {filename}, got {source.name}")
    expected_sha = str(artifact.get("sha256") or "").lower()
    if expected_sha and _sha256_file(source).lower() != expected_sha:
        raise ValueError("capability artifact hash mismatch")


def _configure_flow_criterion(ipk: Any, setup: str, requested: float | None) -> None:
    if requested is None:
        return
    if not math.isfinite(requested) or requested <= 0:
        raise ValueError("flow convergence criterion must be a positive finite number")
    try:
        updated = ipk.get_setup(setup).update({"Convergence Criteria - Flow": str(requested)})
    except Exception as exc:
        raise RuntimeError(f"solver_flow_criterion_configuration_failed: {type(exc).__name__}: {exc}") from exc
    if updated is False:
        raise RuntimeError("solver_flow_criterion_configuration_failed: AEDT Setup update returned false")


def _capture_solved_artifacts(
    ipk: Any,
    *,
    source: Path,
    run_dir: Path,
    project: Mapping[str, Any],
    setup: str,
    requested_flow_criterion: float | None,
) -> dict[str, Any]:
    artifact_dir = run_dir / "artifacts"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    artifact_project = artifact_dir / source.name
    try:
        saved = ipk.save_project(file_name=str(artifact_project), overwrite=False)
    except Exception as exc:
        free_bytes = shutil.disk_usage(artifact_dir).free
        raise RuntimeError(
            f"solver_artifact_save_failed: SaveAs failed; freeBytes={free_bytes}; error={exc}"
        ) from exc
    if saved is False or not artifact_project.is_file():
        free_bytes = shutil.disk_usage(artifact_dir).free
        raise RuntimeError(f"solver_artifact_save_failed: SaveAs produced no project; freeBytes={free_bytes}")
    convergence = collect_convergence_evidence(
        ipk,
        artifact_project=artifact_project,
        output_dir=artifact_dir,
        setup=setup,
        requested_flow_criterion=requested_flow_criterion,
    )
    return {
        "projectPath": str(artifact_project),
        "inputSha256": _sha256_file(source),
        "outputSha256": _sha256_file(artifact_project),
        "aedtVersion": str(project.get("aedtVersion") or ""),
        "design": str(project.get("activeDesign") or ""),
        "setup": setup,
        **convergence,
    }


def run_project_operation(
    source_project: str | Path,
    output_dir: str | Path,
    *,
    mode: str = "inspect",
    version: str = "2024.2",
    design: str | None = None,
    setup: str | None = None,
    cores: int | None = None,
    fan_speed_ratio: float = 1.1,
    flow_convergence_criterion: float | None = None,
    baseline_metrics: Mapping[str, Any] | None = None,
    min_improvement_c: float = 0.5,
    non_graphical: bool = True,
    expected_profile: Mapping[str, Any] | None = None,
    icepak_factory: IcepakFactory | None = None,
    progress: ProgressCallback | None = None,
) -> dict[str, Any]:
    """Inspect, solve, or validate a fan action on an isolated project copy."""
    if mode not in {"inspect", "fan-check", "solve", "fan-solve"}:
        raise ValueError(f"unsupported project operation: {mode}")
    if mode in {"fan-check", "fan-solve"}:
        fan_speed_ratio = validate_fan_speed_ratio(fan_speed_ratio)
    if mode == "fan-solve" and baseline_metrics is None:
        raise ValueError("fan-solve requires baseline metrics")
    if min_improvement_c < 0:
        raise ValueError("minimum improvement must not be negative")
    if cores is not None and (isinstance(cores, bool) or cores < 1):
        raise ValueError("cores must be a positive integer")
    source = Path(source_project).expanduser().resolve()
    profile = dict(expected_profile or {})
    _validate_source(source, profile)
    run_dir = Path(output_dir).expanduser().resolve()
    run_dir.mkdir(parents=True, exist_ok=True)
    working_project = run_dir / source.name
    if working_project == source:
        raise ValueError("output directory must not be the source project directory")
    if working_project.exists():
        raise FileExistsError(f"working project already exists: {working_project}")
    shutil.copyfile(source, working_project)
    _report(progress, "project_copied")

    ipk = None
    try:
        _report(progress, "aedt_lock_waiting")
        with _AEDT_START_LOCK, _without_agent_secrets():
            _report(progress, "aedt_lock_acquired")
            factory_args = {
                "project": str(working_project),
                "design": design,
                "version": version,
                "non_graphical": non_graphical,
                "new_desktop": True,
            }
            if icepak_factory is None:
                ipk = _default_icepak_factory(progress=progress, **factory_args)
            else:
                _report(progress, "aedt_starting")
                ipk = icepak_factory(**factory_args)
        _report(progress, "aedt_started")
        project = _project_metadata(ipk)
        _report(progress, "project_inspected")
        validation = validate_project_profile(project, profile)
        result: dict[str, Any] = {
            "status": "ok",
            "mode": mode,
            "sourceProject": str(source),
            "workingProject": str(working_project),
            "inputSha256": _sha256_file(source),
            "project": project,
            "validation": validation,
            "solve": {"attempted": False},
        }
        if mode == "fan-check":
            result["fanAction"] = apply_fan_speed_ratio(ipk, fan_speed_ratio)
            return result
        if mode == "inspect":
            return result

        selected_setup = setup or (project["setups"][0] if project["setups"] else None)
        if not selected_setup or selected_setup not in project["setups"]:
            raise ValueError(f"setup not found: {selected_setup}")
        if mode == "fan-solve":
            result["fanAction"] = apply_fan_speed_ratio(ipk, fan_speed_ratio)
        _configure_flow_criterion(ipk, selected_setup, flow_convergence_criterion)
        _report(progress, "flow_criterion_configured")
        started = time.time()
        _report(progress, "solving")
        succeeded = bool(ipk.analyze_setup(name=selected_setup, cores=cores, blocking=True))
        finished = time.time()
        _report(progress, "solve_completed")
        if not succeeded:
            raise RuntimeError(f"Icepak solve failed for setup: {selected_setup}")
        result["solve"] = {
            "attempted": True,
            "succeeded": True,
            "setup": selected_setup,
            "durationS": round(finished - started, 3),
            "startedAt": datetime.fromtimestamp(started, timezone.utc).isoformat(),
            "finishedAt": datetime.fromtimestamp(finished, timezone.utc).isoformat(),
        }
        result["metrics"] = collect_temperature_metrics(ipk, project["monitors"])
        result["artifacts"] = _capture_solved_artifacts(
            ipk,
            source=source,
            run_dir=run_dir,
            project=project,
            setup=selected_setup,
            requested_flow_criterion=flow_convergence_criterion,
        )
        convergence = result["artifacts"]["convergenceEvidence"]
        result["metrics"].update(
            {
                "converged": convergence["verified"],
                "convergence": convergence,
                "convergenceEvidenceSource": result["artifacts"]["convergenceEvidenceSource"],
                "flowConverged": convergence.get("flowConverged"),
                "temperatureConverged": convergence.get("temperatureConverged"),
                "monitorTemperatureStable": convergence.get("monitorTemperatureStable"),
                "solverNormalCompletion": convergence.get("solverNormalCompletion"),
                "reversedFlowDetected": bool((convergence.get("reversedFlow") or {}).get("detected")),
            }
        )
        if mode == "fan-solve":
            result["comparison"] = compare_temperature_metrics(
                baseline_metrics or {},
                result["metrics"],
                min_improvement_c=min_improvement_c,
            )
        return result
    finally:
        if ipk is not None:
            try:
                ipk.close_project(save=False)
            finally:
                ipk.release_desktop(close_projects=False, close_desktop=True)

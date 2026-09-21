"""Temperature metric extraction and baseline/candidate comparison."""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any


def temperature_to_c(value: float, unit: str) -> float | None:
    normalized = unit.strip().lower()
    if normalized in {"c", "cel", "degc", "°c"}:
        return value
    if normalized in {"k", "kel", "kelvin"}:
        return value - 273.15
    return None


def collect_temperature_metrics(ipk: Any, monitors: list[str]) -> dict[str, Any]:
    values: dict[str, dict[str, Any]] = {}
    maxima_c: list[float] = []
    for monitor in monitors:
        raw = ipk.post.evaluate_monitor_quantity(monitor=monitor, quantity="Temperature")
        parsed: dict[str, Any] = {}
        for key in ("Min", "Max", "Mean", "Stdev"):
            if key in raw and raw[key] not in (None, ""):
                number = float(raw[key])
                if not math.isfinite(number):
                    raise ValueError(f"temperature monitor {monitor} contains non-finite {key}")
                parsed[key] = number
        unit = str(raw.get("Unit", ""))
        parsed["Unit"] = unit
        values[monitor] = parsed
        if "Max" in parsed:
            maximum_c = temperature_to_c(parsed["Max"], unit)
            if maximum_c is not None:
                maxima_c.append(maximum_c)
    missing = [] if values else ["temperatureMonitors"]
    result: dict[str, Any] = {"temperatureMonitors": values, "missingMetrics": missing}
    if maxima_c:
        result["tmaxC"] = round(max(maxima_c), 6)
    elif values:
        missing.append("tmaxC")
    return result


def _number(metrics: Mapping[str, Any], key: str, label: str) -> float:
    try:
        value = float(metrics[key])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"{label} metrics are missing numeric {key}") from exc
    if not math.isfinite(value):
        raise ValueError(f"{label} metrics contain non-finite {key}")
    return value


def _monitor_maxima_c(metrics: Mapping[str, Any]) -> dict[str, float]:
    maxima: dict[str, float] = {}
    monitors = metrics.get("temperatureMonitors")
    if not isinstance(monitors, Mapping):
        return maxima
    for name, raw in monitors.items():
        if not isinstance(raw, Mapping) or "Max" not in raw:
            continue
        try:
            value = float(raw["Max"])
        except (TypeError, ValueError):
            continue
        converted = temperature_to_c(value, str(raw.get("Unit", "")))
        if converted is not None and math.isfinite(converted):
            maxima[str(name)] = converted
    return maxima


def compare_temperature_metrics(
    baseline: Mapping[str, Any],
    candidate: Mapping[str, Any],
    *,
    min_improvement_c: float = 0.5,
    max_regression_c: float = 0.1,
) -> dict[str, Any]:
    if min_improvement_c < 0 or max_regression_c < 0:
        raise ValueError("temperature comparison thresholds must not be negative")
    baseline_tmax = _number(baseline, "tmaxC", "baseline")
    candidate_tmax = _number(candidate, "tmaxC", "candidate")
    delta = round(candidate_tmax - baseline_tmax, 6)
    baseline_monitors = _monitor_maxima_c(baseline)
    candidate_monitors = _monitor_maxima_c(candidate)
    monitor_deltas = {
        name: round(candidate_monitors[name] - baseline_monitors[name], 6)
        for name in sorted(baseline_monitors.keys() & candidate_monitors.keys())
    }
    return {
        "baselineTmaxC": baseline_tmax,
        "candidateTmaxC": candidate_tmax,
        "deltaTmaxC": delta,
        "minImprovementC": min_improvement_c,
        "maxRegressionC": max_regression_c,
        "improved": delta <= -min_improvement_c,
        "rollbackRequired": delta > max_regression_c or any(value > max_regression_c for value in monitor_deltas.values()),
        "monitorDeltasC": monitor_deltas,
    }


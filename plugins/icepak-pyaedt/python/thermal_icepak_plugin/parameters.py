"""Small, explicit edit adapters. Discovery is repeated against the actual input copy."""
from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Any
from .parameter_registry import AdapterRegistry, ParameterAdapter

_NUMBER = re.compile(r"^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([^\s]*)\s*$")
_LENGTH_UNITS = {"mm", "cm", "m", "um", "in", "mil"}
_CONDITION_UNITS = {"W", "mW", "kW", "cel", "degC", "K", "kel", "Pa", "m_per_sec", "kg_per_sec"}


def _fingerprint(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def _descriptor(adapter: str, target: str, current: str, unit: str, role: str, **extra: Any) -> dict:
    schema = {"version": 1, "type": "enum" if "choices" in extra else "number"}
    for source, key in (("choices", "values"), ("min", "minimum"), ("max", "maximum")):
        if source in extra:
            schema[key] = extra[source]
    if adapter == "fan":
        schema.update(exclusiveMinimum=1, defaultValue="1.1", hint="1.1 表示转速 +10%，允许 >1 至 1.5")
    return {"id": f"{adapter}:{target}", "label": target, "adapter": adapter, "target": target,
            "currentValue": current, "fingerprint": _fingerprint(current), "unit": unit, "role": role, "valueSchema": schema, **extra}


def _discover_builtin(ipk: Any, kind: str) -> list[dict]:
    parameters = []
    manager = getattr(ipk, "variable_manager", None)
    for name, var in (getattr(manager, "variables", {}).items() if kind == "variable" else []):
        expression = str(getattr(var, "expression", ""))
        match = _NUMBER.fullmatch(expression)
        if not match or not math.isfinite(float(match[1])) or bool(getattr(var, "read_only", getattr(var, "readonly", False))):
            continue
        try:
            if not manager.is_used(name):
                continue
        except Exception:
            continue
        unit = match[2]
        role = "operating-condition" if unit in _CONDITION_UNITS else "unclassified"
        parameters.append(_descriptor("variable", str(name), expression, unit, role,
                                      **({"min": 0.000001} if unit in _LENGTH_UNITS else {})))
    modeler = getattr(ipk, "modeler", None)
    # Limit material edits to materials already loaded into the project.
    materials = getattr(ipk, "materials", None)
    fluids = {str(name).lower() for name in [*getattr(materials, "gases", []), *getattr(materials, "liquids", []), "air", "vacuum"]}
    choices = sorted(str(key) for key in getattr(materials, "material_keys", {}) if str(key).lower() not in fluids)
    for name in (getattr(modeler, "object_names", []) if kind == "material" else []):
        try:
            obj = modeler[name]
            current = str(obj.material_name)
            if choices and bool(getattr(obj, "is3d", True)) and current.lower() not in {"air", "vacuum"}:
                parameters.append(_descriptor("material", name, current, "", "design", choices=choices))
        except Exception:
            continue
    for boundary in (getattr(ipk, "boundaries", []) if kind == "boundary-power" else []):
        props = getattr(boundary, "props", {})
        # A total-power source is different from flux, temperature or network BCs.
        if str(getattr(boundary, "type", "")).lower() not in {"block", "sourceicepak"}:
            continue
        if "Total Power" not in props or props.get("Thermal Condition", "Total Power") != "Total Power":
            continue
        current = str(props["Total Power"])
        match = _NUMBER.fullmatch(current)
        if match and match[2] in {"W", "mW", "kW"}:
            parameters.append(_descriptor("boundary-power", boundary.name, current, match[2], "operating-condition", min=0))
    for name, fan in (getattr(ipk, "native_components", {}).items() if kind == "fan" else []):
        provider = getattr(fan, "native_properties", None)
        if provider is None:
            provider = getattr(fan, "props", {}).get("NativeComponentDefinitionProvider", {})
        if provider.get("Type") == "Fan" and provider.get("FlowType") == "Curve" and provider.get("X") and provider.get("Y"):
            parameters.append(_descriptor("fan", name, "1", "", "design", min=1, max=1.5,
                                          fingerprint=_fingerprint({"X": list(provider["X"]), "Y": list(provider["Y"])})))
    return parameters


def discover_parameters(ipk: Any, registry: AdapterRegistry | None = None) -> list[dict]:
    return (registry or DEFAULT_REGISTRY).discover(ipk)


def validate_changes(ipk: Any, changes: Any, registry: AdapterRegistry | None = None) -> list[dict]:
    if not isinstance(changes, list) or not 1 <= len(changes) <= 50:
        raise ValueError("changes must contain 1–50 edits")
    catalog = {item["id"]: item for item in discover_parameters(ipk, registry)}
    seen = set()
    validated = []
    for change in changes:
        if not isinstance(change, dict) or not isinstance(change.get("parameter"), dict):
            raise ValueError("invalid parameter change")
        requested = change["parameter"]
        parameter = catalog.get(requested.get("id"))
        if not parameter or parameter["id"] in seen:
            raise ValueError("parameter unavailable or duplicated")
        seen.add(parameter["id"])
        if any(requested.get(key) != parameter[key] for key in ("adapter", "adapterVersion", "valueSchema", "target", "fingerprint", "currentValue", "unit", "role")):
            raise ValueError(f"parameter changed since inspection: {parameter['label']}")
        role = change.get("role")
        if role not in {"design", "operating-condition"} or (parameter["role"] == "operating-condition" and role != parameter["role"]):
            raise ValueError("operating conditions require a separate baseline")
        value = change.get("value")
        if not isinstance(value, str) or len(value) > 200:
            raise ValueError("invalid target value")
        schema = parameter["valueSchema"]
        if schema["type"] == "enum":
            if value not in schema["values"]:
                raise ValueError("target value must exist in parameter choices")
        else:
            match = _NUMBER.fullmatch(value)
            if not match or match[2] != parameter["unit"] or not math.isfinite(float(match[1])):
                raise ValueError(f"numeric value with unit {parameter['unit']} required")
            number = float(match[1])
            if number < schema.get("minimum", -math.inf) or number > schema.get("maximum", math.inf) or number <= schema.get("exclusiveMinimum", -math.inf):
                raise ValueError("target value outside permitted range")
        if (value == parameter["currentValue"] if schema["type"] == "enum" else values_equal(value, parameter["currentValue"])):
            raise ValueError("target value is unchanged")
        validated.append({"parameter": parameter, "value": value, "role": role})
    return validated


def values_equal(actual: str, expected: str) -> bool:
    a, b = _NUMBER.fullmatch(actual), _NUMBER.fullmatch(expected)
    if a and b and a[2] == b[2]:
        return math.isclose(float(a[1]), float(b[1]), rel_tol=1e-9, abs_tol=1e-12)
    return actual == expected


def apply_changes(ipk: Any, changes: list[dict], registry: AdapterRegistry | None = None) -> list[dict]:
    registry = registry or DEFAULT_REGISTRY
    validated = validate_changes(ipk, changes, registry)  # Validate the entire batch before the first write.
    results = []
    for change in validated:
        p, value = change["parameter"], change["value"]
        result = {"parameterId": p["id"], "target": p["target"], "before": p["currentValue"], "after": value,
                  "verifiedAfter": "", "verified": False}
        result["adapterEvidence"] = registry.get(p["adapter"]).apply(ipk, p, value)
        results.append(result)
    return results


def verify_changes(ipk: Any, changes: list[dict], results: list[dict], registry: AdapterRegistry | None = None) -> None:
    registry = registry or DEFAULT_REGISTRY
    if len(changes) != len(results):
        raise RuntimeError("parameter verification count mismatch")
    for change, result in zip(changes, results):
        p = change["parameter"]
        target, adapter = p["target"], registry.get(p["adapter"])
        if (p.get("adapterVersion") != adapter.version or result.get("parameterId") != p["id"] or
                result.get("target") != p["target"] or result.get("before") != p["currentValue"] or result.get("after") != change["value"]):
            raise RuntimeError("parameter verification identity mismatch")
        actual = adapter.readback(ipk, p, result)
        if not (actual == result["after"] if p["valueSchema"]["type"] == "enum" else values_equal(actual, result["after"])):
            raise RuntimeError(f"persisted parameter verification failed: {target}: {actual}")
        result.update(verifiedAfter=actual, verified=True)


def _write_variable(ipk: Any, parameter: dict, value: str) -> dict:
    if ipk.variable_manager.set_variable(parameter["target"], expression=value) is False:
        raise RuntimeError(f"variable update failed: {parameter['target']}")
    return {}


def _write_material(ipk: Any, parameter: dict, value: str) -> dict:
    if ipk.assign_material(parameter["target"], value) is False:
        raise RuntimeError(f"material update failed: {parameter['target']}")
    return {}


def _write_power(ipk: Any, parameter: dict, value: str) -> dict:
    boundary = next(b for b in ipk.boundaries if b.name == parameter["target"])
    previous = getattr(boundary, "auto_update", True)
    boundary.auto_update = False
    try:
        boundary.props["Total Power"] = value
        if boundary.update() is False:
            raise RuntimeError(f"boundary update failed: {parameter['target']}")
    finally:
        boundary.auto_update = previous
    return {}


def _write_fan(ipk: Any, parameter: dict, value: str) -> dict:
    from .project import apply_fan_speed_ratio
    action = apply_fan_speed_ratio(ipk, float(value), targets=[parameter["target"]])
    return {"fanAfter": action["fans"][0]["after"]}


def _read_fan(ipk: Any, parameter: dict, result: dict) -> str:
    from .project import _fan_provider
    provider = _fan_provider(ipk.native_components[parameter["target"]])
    expected = result["adapterEvidence"]["fanAfter"]
    if any(len(provider.get(axis, [])) != len(expected[axis]) or
           any(not values_equal(str(a), str(b)) for a, b in zip(provider[axis], expected[axis])) for axis in ("X", "Y")):
        raise RuntimeError(f"persisted fan verification failed: {parameter['target']}")
    return result["after"]


def create_default_registry() -> AdapterRegistry:
    registry = AdapterRegistry()
    for identifier, label, write, read in [
        ("variable", "模型变量", _write_variable, lambda ipk, p, _r: str(ipk.variable_manager.variables[p["target"]].expression)),
        ("material", "对象材料", _write_material, lambda ipk, p, _r: str(ipk.modeler[p["target"]].material_name)),
        ("boundary-power", "热源功率", _write_power, lambda ipk, p, _r: str(next(b for b in ipk.boundaries if b.name == p["target"]).props["Total Power"])),
        ("fan", "风扇转速比", _write_fan, _read_fan),
    ]:
        registry.register(ParameterAdapter(identifier, "1.0.0", label,
                                           lambda ipk, kind=identifier: _discover_builtin(ipk, kind), write, read))
    return registry


DEFAULT_REGISTRY = create_default_registry()

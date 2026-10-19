"""Trusted plugin code registers adapters; catalogs never name import paths or executable code."""
from __future__ import annotations

import copy
import math
import re
from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class ParameterAdapter:
    id: str
    version: str
    label: str
    discover: Callable[[Any], list[dict]]
    apply: Callable[[Any, dict, str], dict]
    readback: Callable[[Any, dict, dict], str]


def validate_schema(schema: Any) -> dict:
    if not isinstance(schema, dict) or schema.get("version") != 1 or schema.get("type") not in {"number", "enum"}:
        raise ValueError("unsupported parameter value schema")
    if set(schema) - {"version", "type", "minimum", "maximum", "exclusiveMinimum", "values", "defaultValue", "hint"}:
        raise ValueError("unsupported parameter value schema fields")
    for key in ("minimum", "maximum", "exclusiveMinimum"):
        if key in schema and (isinstance(schema[key], bool) or not isinstance(schema[key], (int, float)) or not math.isfinite(schema[key])):
            raise ValueError("parameter schema bounds must be finite")
    maximum = schema.get("maximum", math.inf)
    if schema.get("minimum", -math.inf) > maximum or schema.get("exclusiveMinimum", -math.inf) >= maximum:
        raise ValueError("empty parameter schema range")
    choices = schema.get("values")
    if schema["type"] == "enum" and (not isinstance(choices, list) or not 1 <= len(choices) <= 1000 or
                                       any(not isinstance(item, str) or not item or len(item) > 200 for item in choices) or len(set(choices)) != len(choices)):
        raise ValueError("invalid parameter schema choices")
    if schema["type"] == "number" and "values" in schema:
        raise ValueError("numeric schema cannot contain choices")
    for key in ("defaultValue", "hint"):
        if key in schema and (not isinstance(schema[key], str) or len(schema[key]) > 500):
            raise ValueError("invalid parameter schema hint")
    return copy.deepcopy(schema)


class AdapterRegistry:
    def __init__(self):
        self._adapters: dict[str, ParameterAdapter] = {}

    def register(self, adapter: ParameterAdapter) -> None:
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,79}", adapter.id) or not re.fullmatch(r"\d+\.\d+\.\d+", adapter.version):
            raise ValueError("invalid parameter adapter identity")
        if adapter.id in self._adapters:
            raise ValueError("parameter adapter already registered")
        if not adapter.label or len(adapter.label) > 150 or not all(callable(fn) for fn in (adapter.discover, adapter.apply, adapter.readback)):
            raise ValueError("incomplete parameter adapter")
        self._adapters[adapter.id] = adapter

    def get(self, identifier: str) -> ParameterAdapter:
        if identifier not in self._adapters:
            raise ValueError("unknown parameter adapter")
        return self._adapters[identifier]

    def discover(self, ipk: Any) -> list[dict]:
        result, seen = [], set()
        for adapter in self._adapters.values():
            for source in adapter.discover(ipk):
                parameter = copy.deepcopy(source)
                for key in ("id", "target", "label", "currentValue", "fingerprint"):
                    if not isinstance(parameter.get(key), str) or not parameter[key] or len(parameter[key]) > 500:
                        raise ValueError("invalid parameter descriptor")
                if parameter["id"] in seen or not parameter["id"].startswith(adapter.id + ":"):
                    raise ValueError("duplicate or foreign parameter identity")
                if parameter.get("role") not in {"design", "operating-condition", "unclassified"} or not isinstance(parameter.get("unit"), str) or len(parameter["unit"]) > 80:
                    raise ValueError("invalid parameter role or unit")
                parameter.update(adapter=adapter.id, adapterVersion=adapter.version, adapterLabel=adapter.label,
                                 valueSchema=validate_schema(parameter.get("valueSchema")))
                seen.add(parameter["id"])
                result.append(parameter)
                if len(result) > 10000:
                    raise ValueError("parameter catalog exceeds limit")
        return result

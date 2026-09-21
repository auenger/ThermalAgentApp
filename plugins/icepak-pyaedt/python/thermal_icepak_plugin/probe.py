"""Detect a local AEDT/PyAEDT environment without starting a solve."""

from __future__ import annotations

import importlib.util
import os
import re
import sys
from pathlib import Path
from typing import Any, Callable

from . import PLUGIN_ID, PLUGIN_VERSION, PROTOCOL_VERSION


def _environment_versions() -> list[str]:
    versions: set[str] = set()
    for key, value in os.environ.items():
        match = re.fullmatch(r"ANSYSEM_ROOT(\d{3})", key.upper())
        if not match or not value or not Path(value).exists():
            continue
        raw = match.group(1)
        versions.add(f"20{raw[:2]}.{raw[2:]}")
    if os.name == "nt":
        program_files = Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
        root = program_files / "AnsysEM"
        if root.is_dir():
            for child in root.iterdir():
                if child.is_dir() and re.fullmatch(r"v\d{3}", child.name, re.IGNORECASE):
                    raw = child.name[1:]
                    versions.add(f"20{raw[:2]}.{raw[2:]}")
    return sorted(versions)


def probe_environment() -> dict[str, object]:
    """Return conservative capability evidence; never claim solve readiness from installation alone."""
    versions = _environment_versions()
    try:
        pyaedt_available = importlib.util.find_spec("ansys.aedt.core") is not None
    except ModuleNotFoundError:
        pyaedt_available = False
    diagnostics: list[str] = []
    if os.name != "nt":
        status = "NOT_INSTALLED"
        diagnostics.append("Icepak execution is supported only on Windows")
    elif not versions:
        status = "NOT_INSTALLED"
        diagnostics.append("No AEDT installation was detected")
    elif not pyaedt_available:
        status = "NEEDS_CONFIG"
        diagnostics.append("AEDT was detected but PyAEDT is unavailable")
    else:
        status = "DETECTED"
        diagnostics.append("AEDT and PyAEDT were detected; launch and license checks have not run")
    return {
        "pluginId": PLUGIN_ID,
        "pluginVersion": PLUGIN_VERSION,
        "protocolVersion": PROTOCOL_VERSION,
        "status": status,
        "platform": sys.platform,
        "aedtVersions": versions,
        "selectedVersion": versions[-1] if versions else None,
        "pyaedtAvailable": pyaedt_available,
        "licenseStatus": "UNKNOWN",
        "capabilities": [
            "environment_probe",
            "health",
            "project_inspect",
            "fan_check",
            "baseline_solve",
            "fan_solve",
            "convergence_evidence",
        ],
        "diagnostics": diagnostics,
    }


def probe_launchability(
    version: str | None = None,
    *,
    base_probe: dict[str, object] | None = None,
    icepak_factory: Callable[..., Any] | None = None,
) -> dict[str, object]:
    """Start and release a fresh Icepak session; never infer a solver license."""
    result = dict(base_probe if base_probe is not None else probe_environment())
    if result["status"] != "DETECTED":
        return result
    versions = result["aedtVersions"]
    selected = version or result["selectedVersion"]
    if selected not in versions:
        result["status"] = "NEEDS_CONFIG"
        result["diagnostics"] = [f"AEDT version {selected} is not detected on this machine"]
        return result
    result["selectedVersion"] = selected
    app = None
    try:
        if icepak_factory is None:
            from ansys.aedt.core import Icepak
            icepak_factory = Icepak
        from .project import _without_agent_secrets
        with _without_agent_secrets():
            app = icepak_factory(version=selected, non_graphical=True, new_desktop=True, close_on_exit=True)
        if app is None:
            raise RuntimeError("PyAEDT did not return an Icepak session")
        result["status"] = "LAUNCHABLE"
        result["diagnostics"] = ["A fresh non-graphical Icepak session started; solver license and project compatibility remain unverified"]
    except Exception as exc:
        result["status"] = "DEGRADED"
        result["diagnostics"] = [f"Icepak session launch failed: {type(exc).__name__}: {str(exc)[:300]}"]
    finally:
        if app is not None:
            try:
                if app.release_desktop(close_projects=True, close_desktop=True) is False:
                    raise RuntimeError("PyAEDT reported unsuccessful desktop release")
            except Exception as exc:
                result["status"] = "DEGRADED"
                result["diagnostics"] = [f"Icepak session cleanup failed: {type(exc).__name__}: {str(exc)[:300]}"]
    return result

"""Detect a local AEDT/PyAEDT environment without starting a solve."""

from __future__ import annotations

import importlib.util
import os
import platform
import re
from pathlib import Path

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
        "platform": platform.platform(),
        "aedtVersions": versions,
        "selectedVersion": versions[-1] if versions else None,
        "pyaedtAvailable": pyaedt_available,
        "licenseStatus": "UNKNOWN",
        "capabilities": ["environment_probe", "health"],
        "diagnostics": diagnostics,
    }

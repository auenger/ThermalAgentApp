"""Protocol and conservative environment probe tests."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

PLUGIN_PYTHON = Path(__file__).resolve().parents[1] / "python"
sys.path.insert(0, str(PLUGIN_PYTHON))

from thermal_icepak_plugin.__main__ import handle_request  # noqa: E402
from thermal_icepak_plugin.probe import _environment_versions, probe_environment  # noqa: E402


class PluginProtocolTests(unittest.TestCase):
    def test_health_returns_versioned_identity(self) -> None:
        response = handle_request({"id": "request-1", "method": "health", "params": {}})
        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["pluginId"], "icepak-pyaedt")
        self.assertEqual(response["result"]["protocolVersion"], "1.0.0")

    def test_unknown_method_is_rejected(self) -> None:
        response = handle_request({"id": "request-2", "method": "solve", "params": {}})
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "METHOD_NOT_FOUND")

    def test_environment_root_is_reported_as_an_aedt_version(self) -> None:
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"ANSYSEM_ROOT242": root}, clear=False):
            self.assertIn("2024.2", _environment_versions())

    def test_non_windows_probe_never_claims_solve_readiness(self) -> None:
        result = probe_environment()
        if os.name != "nt":
            self.assertEqual(result["status"], "NOT_INSTALLED")
            self.assertNotEqual(result["status"], "READY")


if __name__ == "__main__":
    unittest.main()

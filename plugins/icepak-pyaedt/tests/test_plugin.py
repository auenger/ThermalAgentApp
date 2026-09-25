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
from thermal_icepak_plugin.probe import _environment_versions, probe_environment, probe_launchability  # noqa: E402
from thermal_icepak_plugin.project import run_project_operation, validate_fan_speed_ratio  # noqa: E402


class _Named:
    def __init__(self, name: str, kind: str, props: dict | None = None) -> None:
        self.name = name
        self.type = kind
        self.props = props or {}


class _Fan(_Named):
    def __init__(self) -> None:
        provider = {
            "Type": "Fan",
            "FlowType": "Curve",
            "X": ["0", "1", "2"],
            "Y": ["4", "2", "0"],
        }
        super().__init__("Fan1", "Fan", {"NativeComponentDefinitionProvider": provider})
        self.native_properties = provider
        self.auto_update = True
        self.update_calls = 0

    def update(self) -> bool:
        self.update_calls += 1
        return True


class _Monitor:
    all_monitors = {"Chip1": object(), "Chip2": object()}


class _Modeler:
    object_names = ["Chip1", "Chip2"]

    def __getitem__(self, name: str) -> object:
        return type("Object", (), {"material_name": "copper" if name == "Chip1" else "aluminum"})()


class _VariableManager:
    variables = {"FinGap": type("Variable", (), {"expression": "2mm", "units": "mm", "read_only": False})()}

    def is_used(self, name: str) -> bool:
        return name == "FinGap"


class _Post:
    def __init__(self, maximum: float = 121.654) -> None:
        self.maximum = maximum

    def evaluate_monitor_quantity(self, *, monitor: str, quantity: str) -> dict[str, object]:
        self.last_call = (monitor, quantity)
        return {"Min": 60.0, "Max": self.maximum, "Mean": 90.0, "Stdev": 0.2, "Unit": "cel"}


class _FakeIcepak:
    def __init__(self, maximum: float = 121.654) -> None:
        self.project_name = "Project1"
        self.aedt_version_id = "2024.2"
        self.design_name = "IcepakDesign1"
        self.design_list = ["IcepakDesign1"]
        self.setup_names = ["Setup1"]
        self.boundaries = [_Named("Opening1", "Opening", {"Temperature": "30cel"})]
        self.native_components = {"Fan1": _Fan()}
        self.monitor = _Monitor()
        self.modeler = _Modeler()
        self.variable_manager = _VariableManager()
        self.post = _Post(maximum)
        self.closed = False
        self.released = False
        self.analyze_calls: list[dict[str, object]] = []

    def close_project(self, save: bool) -> None:
        self.closed = not save

    def release_desktop(self, *, close_projects: bool, close_desktop: bool) -> None:
        self.released = not close_projects and close_desktop

    def analyze_setup(self, **kwargs: object) -> bool:
        self.analyze_calls.append(kwargs)
        return True

    def save_project(self, *, file_name: str, overwrite: bool) -> bool:
        self.save_overwrite = overwrite
        Path(file_name).write_bytes(b"solved-project")
        return True

    def get_monitor_data(self) -> dict[str, object]:
        return {
            "Chip1": {"Temperature": [121.60 + index * 0.001 for index in range(10)]},
            "Chip2": {"Temperature": [120.70 + index * 0.001 for index in range(10)]},
        }

    def export_convergence(self, setup: str, *, output_file: str) -> str:
        Path(output_file).write_text(
            f"Setup={setup}\nFlow=Converged\nTemperature=Converged\n",
            encoding="utf-8",
        )
        return output_file


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

    def test_project_protocol_error_preserves_request_identity(self) -> None:
        response = handle_request({"id": "request-project", "method": "inspect_project", "params": {}})
        self.assertFalse(response["ok"])
        self.assertEqual(response["id"], "request-project")
        self.assertEqual(response["error"]["code"], "VALUEERROR")

    def test_environment_root_is_reported_as_an_aedt_version(self) -> None:
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"ANSYSEM_ROOT242": root}, clear=False):
            self.assertIn("2024.2", _environment_versions())

    def test_non_windows_probe_never_claims_solve_readiness(self) -> None:
        result = probe_environment()
        self.assertEqual(result["platform"], sys.platform)
        if os.name != "nt":
            self.assertEqual(result["status"], "NOT_INSTALLED")
            self.assertNotEqual(result["status"], "READY")

    def test_launch_probe_starts_isolated_session_and_keeps_license_unknown(self) -> None:
        fake = _FakeIcepak()
        calls: list[dict] = []
        releases: list[dict] = []
        def release(**kwargs: bool) -> bool:
            releases.append(kwargs)
            return True
        fake.release_desktop = release
        base = {**probe_environment(), "status": "DETECTED", "aedtVersions": ["2024.2"], "selectedVersion": "2024.2"}
        def factory(**kwargs: object) -> _FakeIcepak:
            calls.append(kwargs)
            return fake
        result = probe_launchability(base_probe=base, icepak_factory=factory)
        self.assertEqual(result["status"], "LAUNCHABLE")
        self.assertEqual(result["licenseStatus"], "UNKNOWN")
        self.assertEqual(calls, [{"version": "2024.2", "non_graphical": True, "new_desktop": True, "close_on_exit": True}])
        self.assertEqual(releases, [{"close_projects": True, "close_desktop": True}])

    def test_launch_probe_rejects_unknown_version_without_starting(self) -> None:
        base = {**probe_environment(), "status": "DETECTED", "aedtVersions": ["2024.2"], "selectedVersion": "2024.2"}
        result = probe_launchability("2025.1", base_probe=base, icepak_factory=lambda **_: self.fail("must not start"))
        self.assertEqual(result["status"], "NEEDS_CONFIG")

    def test_launch_probe_reports_start_failure_without_claiming_ready(self) -> None:
        base = {**probe_environment(), "status": "DETECTED", "aedtVersions": ["2024.2"], "selectedVersion": "2024.2"}
        def fail(**_: object) -> None:
            raise RuntimeError("launch unavailable")
        result = probe_launchability(base_probe=base, icepak_factory=fail)
        self.assertEqual(result["status"], "DEGRADED")
        self.assertEqual(result["licenseStatus"], "UNKNOWN")

    def test_launch_probe_protocol_validates_version_type(self) -> None:
        response = handle_request({"id": "probe-1", "method": "probe_launchability", "params": {"version": 42}})
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "INVALID_REQUEST")

    def test_project_inspection_uses_copy_and_validates_capability_profile(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "Project1.aedt"
            source.write_bytes(b"original-project")
            fake = _FakeIcepak()
            stages: list[str] = []
            result = run_project_operation(
                source,
                Path(root) / "run",
                icepak_factory=lambda **_kwargs: fake,
                progress=stages.append,
                expected_profile={
                    "project": "Project1",
                    "design": "IcepakDesign1",
                    "setup": "Setup1",
                    "aedtVersion": "ANSYSEM_ROOT242",
                    "artifact": {"filename": "Project1.aedt"},
                    "operationFlow": {"ambientTemperatureC": 30.0},
                    "actions": [{"type": "fan_curve_speed_ratio", "target": "ALL_CURVE_FANS"}],
                },
            )
            self.assertEqual(source.read_bytes(), b"original-project")
            self.assertNotEqual(result["sourceProject"], result["workingProject"])
            self.assertTrue(result["validation"]["verified"])
            catalog = result["parameterCatalog"]
            self.assertEqual(catalog["variables"][0]["name"], "FinGap")
            self.assertEqual(catalog["variables"][0]["expression"], "2mm")
            self.assertTrue(catalog["variables"][0]["used"])
            self.assertEqual(catalog["materials"][0], {"objectName": "Chip1", "materialName": "copper"})
            self.assertEqual(catalog["boundaries"][0]["properties"]["Temperature"], "30cel")
            self.assertEqual(catalog["fans"][0]["actionStatus"], "DISCOVERED")
            self.assertIn("project_inspected", stages)
            self.assertTrue(fake.closed)
            self.assertTrue(fake.released)

    def test_fan_check_scales_curves_and_verifies_read_back_without_saving(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "Project1.aedt"
            source.write_bytes(b"original-project")
            fake = _FakeIcepak()
            result = run_project_operation(
                source,
                Path(root) / "run",
                mode="fan-check",
                fan_speed_ratio=1.1,
                icepak_factory=lambda **_kwargs: fake,
            )
            action = result["fanAction"]
            self.assertTrue(action["verified"])
            self.assertEqual(action["fans"][0]["after"]["X"], ["0", "1.1", "2.2"])
            self.assertEqual(action["fans"][0]["after"]["Y"], ["4.84", "2.42", "0"])
            self.assertEqual(fake.native_components["Fan1"].update_calls, 1)
            self.assertTrue(fake.native_components["Fan1"].auto_update)

    def test_fan_ratio_is_rejected_before_aedt_launch(self) -> None:
        with self.assertRaisesRegex(ValueError, "greater than 1.0"):
            validate_fan_speed_ratio(1.0)

    def test_baseline_solve_collects_metrics_convergence_and_solved_project(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "Project1.aedt"
            source.write_bytes(b"original-project")
            fake = _FakeIcepak()
            result = run_project_operation(
                source,
                Path(root) / "run",
                mode="solve",
                setup="Setup1",
                cores=4,
                icepak_factory=lambda **_kwargs: fake,
            )
            self.assertTrue(result["solve"]["succeeded"])
            self.assertAlmostEqual(result["metrics"]["tmaxC"], 121.654)
            self.assertTrue(result["metrics"]["converged"])
            self.assertEqual(result["artifacts"]["convergenceEvidenceSource"], "pyaedt_export")
            self.assertEqual(Path(result["artifacts"]["projectPath"]).read_bytes(), b"solved-project")
            self.assertEqual(source.read_bytes(), b"original-project")
            self.assertEqual(fake.analyze_calls[0]["cores"], 4)
            self.assertFalse(fake.save_overwrite)

    def test_fan_solve_compares_candidate_against_explicit_baseline(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "Project1.aedt"
            source.write_bytes(b"baseline-project")
            result = run_project_operation(
                source,
                Path(root) / "candidate",
                mode="fan-solve",
                fan_speed_ratio=1.1,
                baseline_metrics={
                    "tmaxC": 121.654,
                    "temperatureMonitors": {
                        "Chip1": {"Max": 121.654, "Unit": "cel"},
                        "Chip2": {"Max": 121.0, "Unit": "cel"},
                    },
                },
                icepak_factory=lambda **_kwargs: _FakeIcepak(117.701),
            )
            self.assertTrue(result["fanAction"]["verified"])
            self.assertTrue(result["comparison"]["improved"])
            self.assertAlmostEqual(result["comparison"]["deltaTmaxC"], -3.953)


if __name__ == "__main__":
    unittest.main()

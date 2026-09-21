"""Pure solver evidence tests that do not require AEDT."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path


PLUGIN_PYTHON = Path(__file__).resolve().parents[1] / "python"
sys.path.insert(0, str(PLUGIN_PYTHON))

from thermal_icepak_plugin.convergence import (  # noqa: E402
    evaluate_monitor_stability,
    parse_native_solver_evidence,
)
from thermal_icepak_plugin.metrics import (  # noqa: E402
    collect_temperature_metrics,
    compare_temperature_metrics,
)


class _Post:
    def evaluate_monitor_quantity(self, *, monitor: str, quantity: str) -> dict[str, object]:
        assert quantity == "Temperature"
        return {
            "Min": 350.0,
            "Max": 394.804 if monitor == "Chip1" else 390.0,
            "Mean": 370.0,
            "Stdev": 1.2,
            "Unit": "kel",
        }


class _Icepak:
    post = _Post()


class SolverLogicTests(unittest.TestCase):
    def test_temperature_metrics_normalize_kelvin_and_keep_monitor_evidence(self) -> None:
        metrics = collect_temperature_metrics(_Icepak(), ["Chip1", "Chip2"])
        self.assertAlmostEqual(metrics["tmaxC"], 121.654)
        self.assertEqual(metrics["missingMetrics"], [])
        self.assertEqual(metrics["temperatureMonitors"]["Chip1"]["Unit"], "kel")

    def test_candidate_comparison_detects_improvement_and_local_regression(self) -> None:
        baseline = {
            "tmaxC": 121.654,
            "temperatureMonitors": {
                "Chip1": {"Max": 121.654, "Unit": "cel"},
                "Chip2": {"Max": 110.0, "Unit": "cel"},
            },
        }
        candidate = {
            "tmaxC": 117.701,
            "temperatureMonitors": {
                "Chip1": {"Max": 117.701, "Unit": "cel"},
                "Chip2": {"Max": 110.2, "Unit": "cel"},
            },
        }
        comparison = compare_temperature_metrics(baseline, candidate)
        self.assertTrue(comparison["improved"])
        self.assertTrue(comparison["rollbackRequired"])
        self.assertAlmostEqual(comparison["deltaTmaxC"], -3.953)
        self.assertAlmostEqual(comparison["monitorDeltasC"]["Chip2"], 0.2)

    def test_native_solver_evidence_requires_residuals_and_stable_monitors(self) -> None:
        iteration_text = (
            "$begin 'Setup'\n"
            "'Include Flow'=true\n"
            "'Include Temperature'=true\n"
            "'Convergence Criteria - Flow'='1e-3'\n"
            "'Convergence Criteria - Energy'='1e-7'\n"
            "'Convergence Criteria - Max Iterations'=500\n"
            "$end 'Setup'\n"
        )
        solver_text = (
            "iter continuity x-velocity y-velocity z-velocity energy time/iter\n"
            "500 9e-6 1e-4 1.2e-4 1.3e-4 5e-9 0:00:00 0\n"
            "Reversed flow on 2 faces (1.5% area) of pressure-outlet Outlet1.\n"
        )
        monitor_data = {"Chip1": {"Temperature": [60.0 + index * 0.02 for index in range(10)]}}
        evidence = parse_native_solver_evidence(
            iteration_text=iteration_text,
            solver_output_text=solver_text,
            profile_text="Normal Completion",
            monitor_data=monitor_data,
        )
        self.assertTrue(evidence["verified"])
        self.assertEqual(evidence["terminationReason"], "converged")
        self.assertTrue(evidence["reversedFlow"]["detected"])
        self.assertTrue(evidence["solverNormalCompletion"])

    def test_monitor_stability_rejects_short_and_drifting_histories(self) -> None:
        short = evaluate_monitor_stability({"Chip1": {"Temperature": [60.0] * 9}})
        self.assertEqual(short["reason"], "insufficient_monitor_history")
        drifting = evaluate_monitor_stability(
            {"Chip1": {"Temperature": [60.0] * 9 + [60.6]}}
        )
        self.assertEqual(drifting["reason"], "monitor_delta_exceeds_0.5c")


if __name__ == "__main__":
    unittest.main()


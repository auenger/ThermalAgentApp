from __future__ import annotations

import tempfile
import unittest
import sys
from pathlib import Path

from pypdf import PdfReader

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from thermal_report_plugin import render_task_report


def sample_payload() -> dict:
    return {
        "generatedAt": "2026-09-21T10:30:00.000Z",
        "task": {
            "id": "task-report-001",
            "title": "服务器机箱两轮散热验证",
            "description": "验证基线并复核风扇转速提高 10% 的候选工况。",
            "executionStatus": "COMPLETED",
            "thermalVerdict": "PASS",
            "approvalStatus": "APPROVED",
            "requirementSnapshot": {
                "projectPath": r"C:\ThermalModels\Project1.aedt",
                "aedtVersion": "2024.2",
                "targetTmaxC": 105,
                "cores": 4,
            },
        },
        "runs": [{
            "id": "run-1", "kind": "BASELINE", "sequence": 1, "status": "COMPLETED", "selectedAttemptId": "attempt-1",
            "attempts": [{
                "id": "attempt-1", "status": "SUCCEEDED", "pluginId": "icepak-pyaedt", "pluginVersion": "0.2.0",
                "startedAt": "2026-09-21T09:00:00Z", "finishedAt": "2026-09-21T10:00:00Z",
                "result": {"metrics": {"tmaxC": 103.56, "converged": True, "flowConverged": True, "temperatureConverged": True, "monitorTemperatureStable": True, "reversedFlowDetected": False, "temperatureMonitors": {"Chip1": {"Max": 103.56, "Unit": "C"}}, "convergence": {"source": "icepak_native_solver_files", "reason": "converged", "flowCriterionConfiguration": {"requested": 0.001, "effective": 0.001}}}},
                "artifacts": [
                    {"role": "INPUT_PROJECT", "sha256": "a" * 64},
                    {"role": "SOLVED_PROJECT", "sha256": "b" * 64},
                    {"role": "SOLVER_RESULT", "sha256": "c" * 64},
                    {"role": "CONVERGENCE_EVIDENCE", "sha256": "d" * 64},
                ],
            }],
        }],
        "events": [{"createdAt": "2026-09-21T10:10:00Z", "eventType": "task.approval_resolved", "fromStatus": "WAITING_FOR_APPROVAL", "toStatus": "COMPLETED", "reason": "工程师复核接受"}],
    }


class ReportTests(unittest.TestCase):
    def test_report_is_readable_embeds_font_and_exposes_auditable_text(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "thermal-report.pdf"
            metadata = render_task_report(sample_payload(), output)
            data = output.read_bytes()
            reader = PdfReader(str(output))
            text = "\n".join(page.extract_text() or "" for page in reader.pages)
            self.assertTrue(data.startswith(b"%PDF"))
            self.assertIn(b"/FontFile2", data)
            self.assertGreaterEqual(metadata["pageCount"], 2)
            self.assertIn("服务器机箱两轮散热验证", text)
            self.assertIn("求解器成功仅表示计算流程完成", text)
            self.assertIn("已接受 / Approved", text)
            self.assertIn("103.56", text)
            self.assertIn("icepak_native_solver_files", text)
            self.assertIn("task.approval_resolved", text)

    def test_report_rejects_unapproved_task(self) -> None:
        payload = sample_payload()
        payload["task"]["approvalStatus"] = "PENDING"
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "completed and approved"):
                render_task_report(payload, Path(directory) / "report.pdf")


if __name__ == "__main__":
    unittest.main()

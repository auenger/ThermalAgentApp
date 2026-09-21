from __future__ import annotations

import hashlib
import os
from functools import lru_cache
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

from pypdf import PdfReader
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

FONT_NAME = "ThermalAgentCJK"
INK = colors.HexColor("#18212B")
MUTED = colors.HexColor("#5C6873")
ACCENT = colors.HexColor("#B44A22")
PAPER = colors.HexColor("#F5F1E8")
LINE = colors.HexColor("#D8D1C5")


@lru_cache(maxsize=1)
def _font_name() -> str:
    override = os.environ.get("REPORT_FONT_PATH")
    windows = Path(os.environ.get("WINDIR", r"C:\Windows"))
    candidates = [
        Path(override) if override else None,
        windows / "Fonts" / "msyh.ttc",
        windows / "Fonts" / "msyh.ttf",
        windows / "Fonts" / "simsun.ttc",
        windows / "Fonts" / "simhei.ttf",
        Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
        Path("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"),
        Path("/System/Library/Fonts/STHeiti Medium.ttc"),
        Path("/System/Library/Fonts/Hiragino Sans GB.ttc"),
    ]
    errors: list[str] = []
    for candidate in candidates:
        if candidate is None or not candidate.is_file():
            continue
        try:
            pdfmetrics.registerFont(TTFont(FONT_NAME, str(candidate), subfontIndex=0))
            return FONT_NAME
        except Exception as exc:  # pragma: no cover - platform-specific font failures
            errors.append(f"{candidate}: {exc}")
    detail = "; ".join(errors)
    raise RuntimeError(
        "No embeddable CJK font found. Set REPORT_FONT_PATH to a TrueType/OpenType CJK font."
        + (f" Tried: {detail}" if detail else "")
    )


def _safe(value: Any, default: str = "-") -> str:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return "是 / Yes" if value else "否 / No"
    if isinstance(value, float):
        return f"{value:.4f}".rstrip("0").rstrip(".")
    if isinstance(value, (dict, list)):
        return f"{len(value)} 项 / items - 完整内容见 JSON 证据"
    return str(value)[:500]


def _dig(value: Any, *keys: str) -> Any:
    current = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _metric(metrics: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in metrics:
            return metrics[key]
    return None


def _status_label(value: Any) -> str:
    labels = {
        "COMPLETED": "已完成 / Completed",
        "APPROVED": "已接受 / Approved",
        "PASS": "达标 / Pass",
        "FAIL": "未达标 / Fail",
        "PENDING": "待判定 / Pending",
        "INVALID": "证据无效 / Invalid",
        "DIVERGED": "未收敛 / Diverged",
    }
    text = _safe(value)
    return labels.get(text, text)


def _artifact_rows(run: dict[str, Any]) -> list[list[str]]:
    rows: list[list[str]] = []
    for attempt in run.get("attempts", []):
        for artifact in attempt.get("artifacts", []):
            rows.append([
                _safe(run.get("kind")),
                _safe(attempt.get("id")),
                _safe(artifact.get("role")),
                _safe(artifact.get("sha256")),
            ])
    return rows


def render_task_report(payload: dict[str, Any], output_path: Path) -> dict[str, Any]:
    task = payload.get("task")
    runs = payload.get("runs")
    if not isinstance(task, dict) or not isinstance(runs, list):
        raise ValueError("task and runs are required")
    if task.get("executionStatus") != "COMPLETED" or task.get("approvalStatus") != "APPROVED":
        raise ValueError("report requires a completed and approved task")

    font = _font_name()
    normal = ParagraphStyle("normal", fontName=font, fontSize=9, leading=13, textColor=INK)
    small = ParagraphStyle("small", parent=normal, fontSize=7.5, leading=10, textColor=MUTED)
    table_text = ParagraphStyle("table", parent=normal, fontSize=7.8, leading=10.5)
    title = ParagraphStyle("title", parent=normal, fontSize=21, leading=27, textColor=INK, spaceAfter=3 * mm)
    kicker = ParagraphStyle("kicker", parent=normal, fontSize=8, leading=10, textColor=ACCENT, spaceAfter=2 * mm)
    heading = ParagraphStyle("heading", parent=normal, fontSize=12, leading=16, textColor=ACCENT, spaceBefore=6 * mm, spaceAfter=2 * mm)
    disclaimer = ParagraphStyle("disclaimer", parent=normal, fontSize=8.5, leading=13, backColor=PAPER, borderColor=LINE, borderWidth=0.5, borderPadding=8)

    def p(value: Any, style: ParagraphStyle = table_text) -> Paragraph:
        return Paragraph(escape(_safe(value)).replace("\n", "<br/>"), style)

    def table(rows: list[list[Any]], widths: list[float], repeat: int = 1) -> Table:
        wrapped = [[p(cell) for cell in row] for row in rows]
        value = Table(wrapped, colWidths=[width * mm for width in widths], hAlign="LEFT", repeatRows=repeat)
        value.setStyle(TableStyle([
            ("FONTNAME", (0, 0), (-1, -1), font),
            ("BACKGROUND", (0, 0), (-1, 0), PAPER),
            ("TEXTCOLOR", (0, 0), (-1, 0), INK),
            ("GRID", (0, 0), (-1, -1), 0.35, LINE),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#FAF8F3")]),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
            ("RIGHTPADDING", (0, 0), (-1, -1), 5),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ]))
        return value

    def page(canvas: Any, document: Any) -> None:
        canvas.saveState()
        canvas.setFont(font, 7.5)
        canvas.setFillColor(MUTED)
        canvas.drawString(18 * mm, 10 * mm, f"Thermal Agent - Task {task.get('id', '-')}")
        canvas.drawRightString(192 * mm, 10 * mm, f"{document.page}")
        canvas.restoreState()

    doc = SimpleDocTemplate(
        str(output_path), pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm,
        topMargin=17 * mm, bottomMargin=17 * mm, title=f"Thermal Agent Report - {task.get('title', '')}",
        author="Thermal Agent",
    )

    requirement = task.get("requirementSnapshot") if isinstance(task.get("requirementSnapshot"), dict) else {}
    summary_rows = [
        ["维度 / Dimension", "结论 / Result", "含义 / Meaning"],
        ["执行状态", _status_label(task.get("executionStatus")), "受管流程是否完成"],
        ["热判定", _status_label(task.get("thermalVerdict")), "是否满足明确温度目标；不等同于求解状态"],
        ["人工审批", _status_label(task.get("approvalStatus")), "用户是否接受当前证据"],
    ]
    task_rows = [
        ["字段 / Field", "值 / Value"],
        ["任务名称 / Task", task.get("title")],
        ["任务 ID", task.get("id")],
        ["说明 / Description", task.get("description")],
        ["源工程 / Source project", requirement.get("projectPath")],
        ["AEDT 版本 / Version", requirement.get("aedtVersion")],
        ["目标最高温度 / Target Tmax", f"{_safe(requirement.get('targetTmaxC'))} °C"],
        ["执行核心数 / Cores", requirement.get("cores")],
        ["生成时间 / Generated at", payload.get("generatedAt")],
    ]

    run_rows: list[list[Any]] = [["轮次", "类型", "Run 状态", "Attempt", "插件", "开始", "结束"]]
    metric_rows: list[list[Any]] = [["轮次", "最高温度", "收敛", "流动", "温度", "监测稳定", "反向流", "对比"]]
    for run in runs:
        attempts = run.get("attempts", []) if isinstance(run, dict) else []
        for attempt in attempts:
            selected = attempt.get("id") == run.get("selectedAttemptId")
            run_rows.append([
                run.get("sequence"), run.get("kind"), run.get("status"),
                f"{attempt.get('status')}{' (selected)' if selected else ''}",
                f"{attempt.get('pluginId')} {attempt.get('pluginVersion')}",
                attempt.get("startedAt"), attempt.get("finishedAt"),
            ])
            if selected:
                result = attempt.get("result") if isinstance(attempt.get("result"), dict) else {}
                metrics = result.get("metrics") if isinstance(result.get("metrics"), dict) else {}
                convergence = metrics.get("convergence") if isinstance(metrics.get("convergence"), dict) else {}
                reversed_flow = convergence.get("reversedFlow") if isinstance(convergence.get("reversedFlow"), dict) else {}
                comparison = result.get("comparison") if isinstance(result.get("comparison"), dict) else {}
                metric_rows.append([
                    run.get("sequence"),
                    f"{_safe(_metric(metrics, 'tmaxC', 'TmaxC', 'Tmax_c'))} °C",
                    _safe(_metric(metrics, 'converged')),
                    _safe(_metric(metrics, 'flowConverged') if 'flowConverged' in metrics else convergence.get('flowConverged')),
                    _safe(_metric(metrics, 'temperatureConverged') if 'temperatureConverged' in metrics else convergence.get('temperatureConverged')),
                    _safe(_metric(metrics, 'monitorTemperatureStable') if 'monitorTemperatureStable' in metrics else convergence.get('monitorTemperatureStable')),
                    _safe(_metric(metrics, 'reversedFlowDetected') if 'reversedFlowDetected' in metrics else reversed_flow.get('detected')),
                    _safe(comparison.get("summary") or comparison.get("deltaTmaxC") or comparison.get("delta_tmax_c")),
                ])

    artifact_rows = [["轮次", "Attempt ID", "角色 / Role", "SHA-256"]]
    for run in runs:
        if isinstance(run, dict):
            artifact_rows.extend(_artifact_rows(run))

    detail_rows: list[list[Any]] = [["轮次", "证据 / Evidence", "值 / Value"]]
    for run in runs:
        if not isinstance(run, dict):
            continue
        selected = next((item for item in run.get("attempts", []) if item.get("id") == run.get("selectedAttemptId")), None)
        if not isinstance(selected, dict):
            continue
        result = selected.get("result") if isinstance(selected.get("result"), dict) else {}
        metrics = result.get("metrics") if isinstance(result.get("metrics"), dict) else {}
        convergence = metrics.get("convergence") if isinstance(metrics.get("convergence"), dict) else {}
        comparison = result.get("comparison") if isinstance(result.get("comparison"), dict) else {}
        for label, value in [
            ("收敛来源 / Source", convergence.get("source")),
            ("收敛原因 / Reason", convergence.get("reason")),
            ("求解结束 / Completion", convergence.get("solverNormalCompletion")),
            ("结束原因 / Termination", convergence.get("terminationReason")),
            ("流动标准 - 请求 / Requested flow criterion", _dig(convergence, "flowCriterionConfiguration", "requested")),
            ("流动标准 - 生效 / Effective flow criterion", _dig(convergence, "flowCriterionConfiguration", "effective")),
            ("反向流次数 / Reversed flow count", _dig(convergence, "reversedFlow", "occurrenceCount")),
            ("温度对比 / Delta Tmax", comparison.get("deltaTmaxC")),
            ("局部回退 / Rollback required", comparison.get("rollbackRequired")),
        ]:
            if value is not None:
                detail_rows.append([run.get("sequence"), label, value])
        for name, monitor in sorted((metrics.get("temperatureMonitors") or {}).items()):
            if isinstance(monitor, dict):
                detail_rows.append([run.get("sequence"), f"温度监测 / Monitor: {name}", f"Max={_safe(monitor.get('Max'))} {monitor.get('Unit', '')}"])
    if len(detail_rows) == 1:
        detail_rows.append(["-", "无附加证据 / No supplemental evidence", "完整结构化数据保存在 SOLVER_RESULT Artifact"])

    event_rows: list[list[Any]] = [["时间 / Time", "事件 / Event", "状态 / Status", "原因 / Reason"]]
    for event in payload.get("events", []):
        if isinstance(event, dict):
            event_rows.append([
                event.get("createdAt"), event.get("eventType"),
                f"{_safe(event.get('fromStatus'))} -> {_safe(event.get('toStatus'))}",
                event.get("reason"),
            ])
    if len(event_rows) == 1:
        event_rows.append(["-", "无可用事件 / No events", "-", "-"])

    story = [
        p("AUDITABLE THERMAL EVIDENCE", kicker),
        p("散热仿真任务报告\nThermal Simulation Task Report", title),
        p("本报告由 Thermal Agent 基于不可变 Artifact 与任务事件生成。", normal),
        p("一、任务与需求 / Task and Requirements", heading),
        table(task_rows, [48, 126]),
        p("二、终局三态 / Final Three-State Result", heading),
        table(summary_rows, [35, 47, 92]),
        p("三、Run 与 Attempt 审计 / Execution Audit", heading),
        table(run_rows, [12, 20, 22, 31, 32, 29, 29]),
        p("四、关键热证据 / Thermal Evidence", heading),
        table(metric_rows, [12, 23, 20, 20, 20, 23, 20, 36]),
        PageBreak(),
        p("五、求解与对比细节 / Solve and Comparison Detail", heading),
        table(detail_rows, [16, 88, 70]),
        p("六、Artifact 完整性 / Artifact Integrity", heading),
        table(artifact_rows, [16, 45, 32, 81]),
        p("七、任务事件 / Task Events", heading),
        table(event_rows, [37, 44, 34, 59]),
        Spacer(1, 7 * mm),
        KeepTogether([
            p("八、工程声明 / Engineering Disclaimer", heading),
            p(
                "求解器成功仅表示计算流程完成，不表示热设计达标。热判定取决于明确目标与可验证的温度、收敛和流动证据；人工审批表示接受当前证据，不替代具备资质的工程签字。"
                " Solver completion does not mean the thermal design passed. The verdict depends on an explicit target and verifiable temperature, convergence, and flow evidence. Human approval accepts the evidence but is not an engineering sign-off.",
                disclaimer,
            ),
        ]),
    ]
    doc.build(story, onFirstPage=page, onLaterPages=page)

    pdf_bytes = output_path.read_bytes()
    reader = PdfReader(str(output_path))
    if not pdf_bytes.startswith(b"%PDF") or not reader.pages:
        raise RuntimeError("generated report is not a readable PDF")
    return {
        "outputPath": str(output_path),
        "pageCount": len(reader.pages),
        "sizeBytes": len(pdf_bytes),
        "sha256": hashlib.sha256(pdf_bytes).hexdigest(),
        "font": font,
    }

"""Read persisted engineering settings in a fresh AEDT session, then generate mesh."""
from __future__ import annotations

import math
import re
import shutil
from pathlib import Path

from .cad import environment, finite_numbers, icepak_session, json_file, output_directory, require, source_file
from .model_preparation import REGION_NAME, SETUP_NAME, included_bounds, padding, setup_properties, validate_spec
from .project import _json_safe, _report


def numeric(raw, unit: str = "") -> float:
    text = str(raw).strip()
    if unit and text.lower().endswith(unit.lower()):
        text = text[:-len(unit)].strip()
    require(bool(re.fullmatch(r"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?", text)), "READBACK_INVALID", f"不能读取数值：{raw}")
    value = float(text)
    require(math.isfinite(value), "READBACK_INVALID", "读回值非有限数")
    return value


def close_number(raw, expected: float, label: str, unit: str = ""):
    require(math.isclose(numeric(raw, unit), expected, abs_tol=1e-7, rel_tol=1e-7), "READBACK_MISMATCH", f"{label} 保存重开后不一致")


def verify_persisted_model(ipk, catalog: dict, spec: dict) -> dict:
    require(ipk.modeler.model_units == spec["units"], "READBACK_MISMATCH", "模型单位不一致")
    require(not getattr(ipk, "native_components", {}) and not getattr(ipk.modeler, "user_defined_components", {}), "EXTERNAL_DEPENDENCY", "首版不支持需要外部定义的组件")
    mapped = {o["key"]: o for o in catalog["objects"]}
    included = {mapped[o["objectKey"]]["name"] for o in spec["objects"] if o["included"]}
    require(set(ipk.modeler.object_names) == included | {REGION_NAME}, "READBACK_MISMATCH", "工程实体集合与配置不一致")
    monitors = ipk.monitor.all_monitors
    actual = {"objects": [], "monitoringScope": "SELECTED_OBJECT_CENTROIDS"}
    expected_monitor_names = set()
    expected_boundary_names = set()
    for obj in spec["objects"]:
        if not obj["included"]:
            continue
        original = mapped[obj["objectKey"]]
        name = original["name"]
        solid = ipk.modeler[name]
        require(str(solid.material_name).lower() == obj["material"]["value"].lower(), "READBACK_MISMATCH", f"{name} 材料不一致")
        require(solid.solve_inside is True, "READBACK_MISMATCH", f"{name} 没有启用实体内部求解")
        bounds = finite_numbers(solid.bounding_box, 6, name)
        for a, e in zip(bounds, original["boundingBox"]):
            close_number(a, e, f"{name} 几何")
        if obj["role"] == "HEAT_SOURCE":
            boundary_name = f"Heat_{obj['objectKey'][:12]}"
            expected_boundary_names.add(boundary_name)
            boundary = next((b for b in ipk.boundaries if b.name == boundary_name), None)
            require(boundary is not None and list(boundary.props.get("Objects", [])) == [name] and boundary.props.get("Block Type") == "Solid", "READBACK_MISMATCH", f"{name} 热源对象或类型不一致")
            close_number(boundary.props.get("Total Power"), obj["powerW"]["value"], f"{name} 功率", "W")
        if obj["monitor"]:
            monitor_name = f"Temp_{obj['objectKey'][:12]}"
            expected_monitor_names.add(monitor_name)
            monitor = monitors.get(monitor_name)
            require(monitor is not None, "READBACK_MISMATCH", f"{name} 缺少温度监测")
            require(monitor.geometry_assignment == name and "Temperature" in monitor.quantities, "READBACK_MISMATCH", f"{name} 监测对象或数量不一致")
        actual["objects"].append({"name": name, "material": str(solid.material_name), "powerW": obj["powerW"]["value"], "monitored": obj["monitor"], "boundingBox": bounds})
    require(set(monitors) == expected_monitor_names, "READBACK_MISMATCH", "存在多余或缺失监测点")
    region = ipk.modeler[REGION_NAME]
    require(str(region.material_name).lower() == "air", "READBACK_MISMATCH", "计算域不是空气")
    bounds = included_bounds(spec, catalog)
    pads = padding(spec, bounds)
    expected_bounds = [bounds[i] - pads[i] for i in range(3)] + [bounds[i + 3] + pads[i] for i in range(3)]
    for a, e in zip(finite_numbers(region.bounding_box, 6, "计算域"), expected_bounds):
        close_number(a, e, "计算域尺寸")
    openings = [b for b in ipk.boundaries if b.type == "Opening"]
    require(len(openings) == 1, "READBACK_MISMATCH", "开放边界数量不一致")
    opening = openings[0]
    require(set(opening.props.get("Faces", [])) == {f.id for f in region.faces} and opening.props.get("Inlet Type") == "Pressure", "READBACK_MISMATCH", "开放边界不在全部计算域外表面")
    close_number(opening.props.get("Temperature"), spec["ambientTemperatureC"]["value"], "开放边界温度", "cel")
    require(set(b.name for b in ipk.boundaries) == expected_boundary_names | {opening.name}, "READBACK_MISMATCH", "存在额外热边界")
    # These values must come from the freshly opened engineering model, never from the spec.
    settings = ipk.design_settings
    close_number(settings["AmbTemp"], spec["ambientTemperatureC"]["value"], "环境温度", "cel")
    axis = str(settings["GravityVec"]).split("::")[-1].upper()
    sign = "-" if str(settings["GravityDir"]).lower() in {"negative", "false"} else "+"
    require(sign + axis == spec["gravity"]["value"], "READBACK_MISMATCH", "重力方向不一致")
    require(ipk.setup_names == [SETUP_NAME], "READBACK_MISMATCH", "Setup 集合不一致")
    props = ipk.get_setup(SETUP_NAME).props
    for key, expected in setup_properties(spec).items():
        if isinstance(expected, bool):
            require(props.get(key) is expected, "READBACK_MISMATCH", f"{key} 不一致")
        elif key in {"Flow Regime", "Radiation Model"}:
            require(props.get(key) == expected, "READBACK_MISMATCH", f"{key} 不一致")
        else:
            close_number(props.get(key), float(expected), key)
    mesh = ipk.mesh.global_mesh_region
    require(mesh.manual_settings is False, "READBACK_MISMATCH", "全局网格不是自动等级模式")
    close_number(mesh.settings["MeshRegionResolution"], spec["meshLevel"]["value"], "网格等级")
    expected_local = {mapped[o["objectKey"]]["name"] for o in spec["objects"] if o["included"] and o["role"] in {"HEAT_SOURCE", "HEATSINK"}}
    local_operations = [o for o in ipk.mesh.meshoperations if o.name.startswith("ThermalLocalMesh")]
    actual_local = set()
    for operation in local_operations:
        close_number(operation.props.get("Level"), spec["meshLevel"]["value"], "局部网格等级")
        actual_local.update(operation.props.get("Objects", []))
    require(actual_local == expected_local, "READBACK_MISMATCH", "局部网格对象映射不一致")
    actual.update(ambientTemperatureC=numeric(settings["AmbTemp"], "cel"), gravity=sign + axis,
                  regionBoundingBox=expected_bounds, setup=_json_safe(dict(props)), meshLevel=mesh.settings["MeshRegionResolution"],
                  monitors=sorted(monitors), localMeshObjects=sorted(actual_local))
    return actual


def validate_model(*, project_path: str, project_sha256: str, catalog: dict, spec: dict, spec_sha256: str,
                   output_dir: str, icepak_factory=None, progress=None) -> dict:
    validate_spec(spec, catalog)
    source = source_file(project_path, project_sha256, {".aedt"})
    run_dir = output_directory(output_dir)
    # Copy only the archived AEDT input; no imported geometry folder, libraries or results accompany it.
    working = run_dir / "Validation.aedt"
    shutil.copyfile(source, working)
    with icepak_session(project=str(working), version=spec["aedtVersion"], icepak_factory=icepak_factory, progress=progress) as ipk:
        _report(progress, "persisted_model_reading")
        actual = verify_persisted_model(ipk, catalog, spec)
        validation_log = run_dir / "geometry-validation.log"
        require(ipk.validate_simple(log_file=str(validation_log)) == 1, "GEOMETRY_VALIDATION_FAILED", "Icepak 几何/模型检查未通过，详见日志")
        _report(progress, "mesh_generating")
        require(ipk.mesh.generate_mesh(name=SETUP_NAME) is True, "MESH_FAILED", "网格生成失败")
        mesh_file = run_dir / "mesh-stats.txt"
        ipk.export_mesh_stats(setup=SETUP_NAME, output_file=str(mesh_file))
        require(mesh_file.is_file() and mesh_file.stat().st_size > 0, "MESH_EVIDENCE_MISSING", "未取得有效网格统计文件")
        result = {"status": "ok", "operation": "validate_model", "inputSha256": project_sha256, "specSha256": spec_sha256,
                  "environment": environment(ipk, test_double=icepak_factory is not None), "validation": {"verified": True, "selfContained": True, "meshGenerated": True,
                    "design": str(ipk.design_name), "setup": SETUP_NAME,
                    "checks": ["persistedModelSpec", "isolatedProjectReopen", "noExternalComponents", "geometryValidation", "meshGeneration", "meshStatistics"], "actual": actual}, "artifacts": []}
        evidence = run_dir / "validation.json"
        json_file(evidence, result)
        result["artifacts"] = [{"role": "VALIDATION_EVIDENCE", "path": str(evidence)}, {"role": "MESH_STATS", "path": str(mesh_file)}]
        if validation_log.is_file() and validation_log.stat().st_size:
            result["artifacts"].append({"role": "GEOMETRY_LOG", "path": str(validation_log)})
        _report(progress, "model_verified")
        return result

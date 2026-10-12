"""Deterministic first-version natural convection model builder."""
from __future__ import annotations

import math
import shutil
from pathlib import Path

from .cad import (ModelPreparationError, environment, finite_numbers, icepak_session, json_file,
                  output_directory, require, save_project, source_file)
from .project import _report

SETUP_NAME = "ThermalBaseline"
REGION_NAME = "Region"
MATERIALS = {"aluminum", "copper", "silicon", "steel", "FR4_epoxy"}
GRAVITY_DIRECTIONS = {"-X": 0, "-Y": 1, "-Z": 2, "+X": 3, "+Y": 4, "+Z": 5}
UNITS_TO_MM = {"mm": 1.0, "cm": 10.0, "m": 1000.0, "um": 0.001, "in": 25.4, "mil": 0.0254}


def validate_spec(spec: dict, catalog: dict) -> None:
    require(isinstance(spec, dict) and isinstance(catalog, dict), "SPEC_INVALID", "配置和对象目录必须是对象")
    require(spec.get("schemaVersion") == 1 and spec.get("templateId") == "steady-natural-convection-v1" and spec.get("templateVersion") == 1,
            "SPEC_INVALID", "建模模板版本无效")
    for key in ("inspectionId", "sourceSha256", "units"):
        require(spec.get(key) == catalog.get(key), "CATALOG_MISMATCH", f"{key} 与导入清单不一致")
    require(spec.get("dimensionsConfirmed") is True and spec.get("assumptionsConfirmed") is True and bool(spec.get("contactNotes")), "SPEC_INCOMPLETE", "单位、尺寸、接触关系和模板假设尚未确认")
    require(bool(spec.get("author")) and bool(spec.get("reason")), "SPEC_INCOMPLETE", "缺少记录人或建模依据")
    require(spec["units"] in UNITS_TO_MM, "UNITS_UNSUPPORTED", "当前单位尚未适配，请重新检查几何单位")
    require(not any(d.get("severity") == "ERROR" for d in catalog.get("diagnostics", [])), "GEOMETRY_INVALID", "导入几何存在致命问题")
    objects = spec.get("objects", [])
    expected = {o["key"]: o for o in catalog["objects"]}
    require(len(objects) == len(expected) and {o.get("objectKey") for o in objects} == set(expected), "OBJECT_MAPPING_INVALID", "实体映射缺失、重复或过期")
    power = 0
    monitors = 0
    for obj in objects:
        require(isinstance(obj.get("included"), bool) and isinstance(obj.get("monitor"), bool), "SPEC_INVALID", "实体参与/监测状态无效")
        p = obj["powerW"]["value"]
        require(isinstance(p, (int, float)) and not isinstance(p, bool) and math.isfinite(p) and 0 <= p <= 1e7, "SPEC_INVALID", "功率值无效")
        if not obj["included"]:
            require(obj["role"] == "EXCLUDED" and obj.get("exclusionReason") and not obj["monitor"] and p == 0, "SPEC_INCOMPLETE", "排除实体须填写原因且不能发热/监测")
            continue
        require(expected[obj["objectKey"]]["type"] == "Solid" and obj["role"] in {"SOLID", "HEATSINK", "HEAT_SOURCE"}, "SPEC_INVALID", "首版只支持固体实体")
        require(obj["material"]["value"] in MATERIALS and obj["material"].get("confirmed") is True, "SPEC_INCOMPLETE", "材料尚未选择或确认")
        if obj["role"] == "HEAT_SOURCE":
            require(p > 0 and obj["powerW"].get("confirmed") is True, "SPEC_INCOMPLETE", "热源功率尚未确认")
            power += p
        else:
            require(p == 0, "SPEC_INVALID", "非热源不能施加功率")
        monitors += int(obj["monitor"])
    require(power > 0 and monitors > 0, "SPEC_INCOMPLETE", "至少需要一个正功率热源和一个监测位置")
    bounds = {"ambientTemperatureC": (-100, 500), "regionPaddingPercent": (10, 1000), "regionMinPaddingMm": (1, 10000),
              "meshLevel": (1, 5), "maxIterations": (10, 10000), "flowConvergence": (1e-12, 0.1), "energyConvergence": (1e-12, 0.1)}
    for key, (minimum, maximum) in bounds.items():
        field = spec.get(key, {})
        value = field.get("value")
        require(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and minimum <= value <= maximum and field.get("confirmed") is True,
                "SPEC_INCOMPLETE", f"{key} 未确认或数值无效")
        if key in {"meshLevel", "maxIterations"}:
            require(int(value) == value, "SPEC_INVALID", f"{key} 必须为整数")
    require(spec.get("gravity", {}).get("value") in GRAVITY_DIRECTIONS and spec["gravity"].get("confirmed") is True, "SPEC_INCOMPLETE", "重力方向未确认")
    require(float(spec["aedtVersion"]) < 2027.1, "VERSION_UNSUPPORTED", "2027.1 及以上重力适配尚未验证")


def setup_properties(spec: dict) -> dict:
    return {"Flow Regime": "Laminar", "Include Temperature": True, "Include Flow": True, "Include Gravity": True,
            "Radiation Model": "Off", "Convergence Criteria - Max Iterations": spec["maxIterations"]["value"],
            "Convergence Criteria - Flow": str(spec["flowConvergence"]["value"]),
            "Convergence Criteria - Energy": str(spec["energyConvergence"]["value"])}


def included_bounds(spec: dict, catalog: dict) -> list[float]:
    included = {o["objectKey"] for o in spec["objects"] if o["included"]}
    objects = [o for o in catalog["objects"] if o["key"] in included]
    return [min(o["boundingBox"][i] for o in objects) for i in range(3)] + [max(o["boundingBox"][i + 3] for o in objects) for i in range(3)]


def padding(spec: dict, bounds: list[float]) -> list[float]:
    return [max((bounds[i + 3] - bounds[i]) * spec["regionPaddingPercent"]["value"] / 100,
                spec["regionMinPaddingMm"]["value"] / UNITS_TO_MM[spec["units"]]) for i in range(3)]


def verify_import_geometry(ipk, catalog: dict) -> None:
    require(ipk.modeler.model_units == catalog["units"], "UNITS_MISMATCH", "工程单位与导入清单不一致")
    for obj in catalog["objects"]:
        require(obj["name"] in ipk.modeler.object_names, "OBJECT_MISSING", f"对象 {obj['name']} 已失效")
        actual = ipk.modeler[obj["name"]]
        bounds = finite_numbers(actual.bounding_box, 6, obj["name"])
        require(actual.object_type == obj["type"] and all(math.isclose(a, b, rel_tol=1e-7, abs_tol=1e-7) for a, b in zip(bounds, obj["boundingBox"])),
                "GEOMETRY_MISMATCH", f"对象 {obj['name']} 几何与导入清单不一致")


def prepare_model(*, project_path: str, project_sha256: str, catalog: dict, spec: dict, spec_sha256: str,
                  output_dir: str, icepak_factory=None, progress=None) -> dict:
    validate_spec(spec, catalog)
    source = source_file(project_path, project_sha256, {".aedt"})
    run_dir = output_directory(output_dir)
    working = run_dir / "Working.aedt"
    shutil.copyfile(source, working)
    generated = run_dir / "ThermalModel.aedt"
    with icepak_session(project=str(working), version=spec["aedtVersion"], icepak_factory=icepak_factory, progress=progress) as ipk:
        verify_import_geometry(ipk, catalog)
        require(not ipk.setup_names and not ipk.boundaries and not ipk.monitor.all_monitors, "IMPORT_NOT_CLEAN", "导入工程已有热边界或求解设置，不能当作新建模型")
        _report(progress, "materials_assigning")
        mapped = {o["key"]: o for o in catalog["objects"]}
        logs = []
        for obj in spec["objects"]:
            name = mapped[obj["objectKey"]]["name"]
            if not obj["included"]:
                require(ipk.modeler.delete(name) is True, "OBJECT_EXCLUSION_FAILED", f"不能排除对象 {name}")
                logs.append({"object": name, "action": "excluded", "reason": obj["exclusionReason"]})
                continue
            require(ipk.assign_material(name, obj["material"]["value"]) is True, "MATERIAL_FAILED", f"材料赋值失败：{name}")
            ipk.modeler[name].solve_inside = True
            if obj["role"] == "HEAT_SOURCE":
                require(bool(ipk.assign_solid_block(name, f"{obj['powerW']['value']}W", boundary_name=f"Heat_{obj['objectKey'][:12]}")),
                        "HEAT_SOURCE_FAILED", f"热源设置失败：{name}")
            if obj["monitor"]:
                require(bool(ipk.monitor.assign_point_monitor_in_object(name, monitor_quantity="Temperature", monitor_name=f"Temp_{obj['objectKey'][:12]}")),
                        "MONITOR_FAILED", f"监测设置失败：{name}")
            logs.append({"object": name, "action": "configured", "material": obj["material"]["value"], "powerW": obj["powerW"]["value"], "monitor": obj["monitor"]})
        _report(progress, "environment_configuring")
        require(ipk.edit_design_settings(gravity_dir=GRAVITY_DIRECTIONS[spec["gravity"]["value"]], ambient_temperature=spec["ambientTemperatureC"]["value"],
                                         perform_validation=False, check_level="Strict", default_fluid="air", ignore_unclassified_objects=False, skip_intersection_checks=False) is True,
                "ENVIRONMENT_FAILED", "环境或重力设置失败")
        # Fresh Icepak projects can contain the automatic air Region already.
        if REGION_NAME in ipk.modeler.object_names:
            require(REGION_NAME not in {o["name"] for o in catalog["objects"]}, "REGION_NAME_CONFLICT", "CAD 对象使用了保留名称 Region，请调整名称")
            require(ipk.modeler.delete(REGION_NAME) is True, "REGION_FAILED", "不能重建初始空气域")
        pads = padding(spec, included_bounds(spec, catalog))
        region = ipk.modeler.create_region(pad_value=[f"{p}{spec['units']}" for p in pads for _ in range(2)], pad_type="Absolute Offset", name=REGION_NAME)
        require(region, "REGION_FAILED", "空气计算域生成失败")
        require(ipk.assign_material(REGION_NAME, "air") is True, "REGION_FAILED", "计算域空气材料设置失败")
        boundary = ipk.assign_openings([f.id for f in region.faces])
        require(boundary, "BOUNDARY_FAILED", "开放边界生成失败")
        boundary.props["Temperature"] = f"{spec['ambientTemperatureC']['value']}cel"
        require(boundary.update() is True, "BOUNDARY_FAILED", "开放边界温度保存失败")
        _report(progress, "setup_creating")
        ipk.solution_type = "SteadyState"
        setup = ipk.create_setup(name=SETUP_NAME)
        require(setup and setup.update(setup_properties(spec)) is True, "SETUP_FAILED", "稳态求解配置失败")
        global_mesh = ipk.mesh.global_mesh_region
        global_mesh.manual_settings = False
        global_mesh.settings["MeshRegionResolution"] = spec["meshLevel"]["value"]
        require(global_mesh.update() is True, "MESH_CONFIGURATION_FAILED", "全局网格设置失败")
        # Explicit local refinements for heat sources and heatsinks.
        mesh_order = {mapped[o["objectKey"]]["name"]: spec["meshLevel"]["value"] for o in spec["objects"] if o["included"] and o["role"] in {"HEAT_SOURCE", "HEATSINK"}}
        require(bool(ipk.mesh.assign_mesh_level(mesh_order, name="ThermalLocalMesh")), "MESH_CONFIGURATION_FAILED", "局部网格设置失败")
        save_project(ipk, generated)
        evidence = {"sourceProjectSha256": project_sha256, "specSha256": spec_sha256, "template": spec["templateId"], "mapping": logs,
                    "regionPadding": pads, "design": str(ipk.design_name), "setup": SETUP_NAME,
                    "assumptions": ["ideal touching contacts", "gaps retained", "radiation off", "object centroid temperature monitors"], "environment": environment(ipk, test_double=icepak_factory is not None)}
        result = {"status": "ok", "operation": "prepare_model", "inputSha256": project_sha256, "specSha256": spec_sha256,
                  "projectPath": str(generated), "environment": environment(ipk, test_double=icepak_factory is not None), "artifacts": [
                      {"role": "GENERATED_PROJECT", "path": str(generated)},
                      {"role": "PREPARATION_EVIDENCE", "path": json_file(run_dir / "preparation.json", evidence)}]}
        _report(progress, "model_saved")
        return result

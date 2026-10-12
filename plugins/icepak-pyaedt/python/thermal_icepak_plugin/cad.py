"""CAD import into a fresh, isolated Icepak project. Never runs a solver."""
from __future__ import annotations

import hashlib
import json
import math
import platform
from contextlib import contextmanager
from importlib.metadata import PackageNotFoundError, version as package_version
from pathlib import Path
from typing import Any

from .project import (_AEDT_START_LOCK, _default_icepak_factory, _normalize_aedt_version,
                      _report, _sha256_file, _without_agent_secrets)
from .managed import track_session


class ModelPreparationError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


SUPPORTED_PYAEDT_VERSION = "1.6.0"


def require(condition: Any, code: str, message: str) -> None:
    if not condition:
        raise ModelPreparationError(code, message)


def json_file(path: Path, value: Any) -> str:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    return str(path)


def source_file(raw_path: str, expected_sha: str, extensions: set[str]) -> Path:
    path = Path(raw_path).expanduser().resolve()
    require(path.is_file(), "INPUT_MISSING", "输入文件不存在")
    require(path.suffix.lower() in extensions, "UNSUPPORTED_FORMAT", "首版 CAD 转换只支持 STEP/STP；工程输入须为 AEDT")
    require(_sha256_file(path) == expected_sha, "INPUT_SHA_MISMATCH", "输入文件 SHA256 不一致")
    return path


def output_directory(raw_path: str) -> Path:
    path = Path(raw_path).expanduser().resolve()
    require(not path.exists(), "OUTPUT_EXISTS", "输出目录已存在；重试必须使用新的作业目录")
    path.mkdir(parents=True)
    return path


@contextmanager
def icepak_session(*, project: str, version: str, design: str | None = None,
                   icepak_factory=None, progress=None):
    ipk = None
    try:
        _report(progress, "aedt_starting")
        with _AEDT_START_LOCK, _without_agent_secrets():
            if icepak_factory is None:
                require(platform.system() == "Windows", "ENVIRONMENT_UNAVAILABLE", "真实 CAD 转换需在 Windows Icepak 环境运行")
                try:
                    installed = package_version("pyaedt")
                except PackageNotFoundError:
                    installed = "unavailable"
                require(installed == SUPPORTED_PYAEDT_VERSION, "PYAEDT_VERSION_UNSUPPORTED", f"首版建模适配 PyAEDT {SUPPORTED_PYAEDT_VERSION}，当前为 {installed}")
            factory = icepak_factory or _default_icepak_factory
            ipk = factory(project=project, design=design, version=version, non_graphical=True, new_desktop=True)
        track_session(ipk)
        require(_normalize_aedt_version(getattr(ipk, "aedt_version_id", "")) == version,
                "VERSION_MISMATCH", "实际 AEDT 版本与选择版本不一致")
        _report(progress, "aedt_started")
        yield ipk
    finally:
        if ipk is not None:
            try:
                ipk.close_project(save=False)
            finally:
                ipk.release_desktop(close_projects=False, close_desktop=True)


def environment(ipk, *, test_double: bool = False) -> dict:
    try:
        pyaedt_version = package_version("pyaedt")
    except PackageNotFoundError:
        pyaedt_version = "unavailable"
    return {"aedtVersion": str(ipk.aedt_version_id), "pyaedtVersion": pyaedt_version,
            "platform": platform.system(), "evidenceKind": "TEST_DOUBLE" if test_double else "REAL_ICEPAK"}


def finite_numbers(values, length: int, label: str) -> list[float]:
    require(isinstance(values, (list, tuple)) and len(values) == length, "GEOMETRY_INVALID", f"{label} 数据缺失")
    try:
        numbers = [float(v) for v in values]
    except (ValueError, TypeError) as exc:
        raise ModelPreparationError("GEOMETRY_INVALID", f"{label} 非数值") from exc
    require(all(math.isfinite(n) for n in numbers), "GEOMETRY_INVALID", f"{label} 数值无效")
    return numbers


def catalog_objects(ipk, names: list[str], inspection_id: str, source_sha: str) -> dict:
    objects = []
    diagnostics = []
    for name in sorted(names):
        obj = ipk.modeler[name]
        kind = str(obj.object_type)
        require(kind in {"Solid", "Sheet", "Line"}, "GEOMETRY_INVALID", f"{name} 为未分类对象")
        bounds = finite_numbers(obj.bounding_box, 6, f"{name} 包围盒")
        require(all(bounds[i + 3] >= bounds[i] for i in range(3)), "GEOMETRY_INVALID", f"{name} 尺寸非法")
        key = hashlib.sha256(f"{inspection_id}:{name}".encode()).hexdigest()
        volume = getattr(obj, "volume", None) if kind == "Solid" else None
        volume = float(volume) if volume is not None else None
        require(volume is None or math.isfinite(volume), "GEOMETRY_INVALID", f"{name} 体积非法")
        if kind == "Solid" and (volume is not None and volume <= 0 or any(bounds[i + 3] <= bounds[i] for i in range(3))):
            diagnostics.append({"code": "ZERO_VOLUME", "severity": "ERROR", "message": f"{name} 无有效实体体积", "objectKeys": [key]})
        if kind != "Solid":
            diagnostics.append({"code": "NON_SOLID", "severity": "WARNING", "message": f"{name} 是 {kind}，首版须排除", "objectKeys": [key]})
        material = str(getattr(obj, "material_name", ""))
        objects.append({"key": key, "name": name, "type": kind, "boundingBox": bounds,
                        "volume": volume, "materialName": material if material.lower() not in {"", "vacuum", "air"} else None})
    require(objects, "CAD_EMPTY", "CAD 导入后没有可用对象")
    bounds = [min(o["boundingBox"][i] for o in objects) for i in range(3)] + [max(o["boundingBox"][i + 3] for o in objects) for i in range(3)]
    diagnostics.append({"code": "CONTACT_REVIEW_REQUIRED", "severity": "WARNING", "message": "请核对关键接触、间隙和薄层；实体清单不代表接触关系已验证。"})
    return {"schemaVersion": 1, "inspectionId": inspection_id, "sourceSha256": source_sha,
            "units": str(ipk.modeler.model_units), "boundingBox": bounds, "objects": objects, "diagnostics": diagnostics}


def save_project(ipk, path: Path) -> None:
    require(ipk.save_project(file_name=str(path), overwrite=False) is not False and path.is_file(),
            "PROJECT_SAVE_FAILED", "工程保存失败")


def inspect_cad(*, source_path: str, source_sha256: str, inspection_id: str, output_dir: str,
                version: str, healing: bool = False, icepak_factory=None, progress=None) -> dict:
    source = source_file(source_path, source_sha256, {".step", ".stp"})
    run_dir = output_directory(output_dir)
    working = run_dir / "Imported.aedt"
    with icepak_session(project=str(working), version=version, icepak_factory=icepak_factory, progress=progress) as ipk:
        before = set(ipk.modeler.object_names)
        _report(progress, "cad_importing")
        require(ipk.import_3d_cad(str(source), healing=healing, import_materials=True,
                                  create_lightweight_part=False, group_by_assembly=False,
                                  import_free_surfaces=True, merge_planar_faces=True) is True,
                "CAD_IMPORT_FAILED", "Icepak CAD 导入失败")
        imported = sorted(set(ipk.modeler.object_names) - before)
        catalog = catalog_objects(ipk, imported, inspection_id, source_sha256)
        _report(progress, "cad_catalog_created")
        save_project(ipk, working)
        artifacts = [{"role": "IMPORTED_PROJECT", "path": str(working)},
                     {"role": "OBJECT_CATALOG", "path": json_file(run_dir / "objects.json", catalog)}]
        preview = run_dir / "preview.jpg"
        try:
            ipk.export_design_preview_to_jpg(str(preview))
            if preview.is_file():
                artifacts.append({"role": "PREVIEW", "path": str(preview)})
        except Exception:
            catalog["diagnostics"].append({"code": "PREVIEW_UNAVAILABLE", "severity": "INFO", "message": "当前环境无法导出预览，可下载工程查看。"})
            json_file(run_dir / "objects.json", catalog)
        _report(progress, "cad_saved")
        result = {"status": "ok", "operation": "inspect_cad", "inputSha256": source_sha256,
                  "projectPath": str(working), "catalog": catalog, "environment": environment(ipk, test_double=icepak_factory is not None), "artifacts": artifacts}
        json_file(run_dir / "inspection.json", result)
        result["artifacts"].append({"role": "IMPORT_EVIDENCE", "path": str(run_dir / "inspection.json")})
        return result

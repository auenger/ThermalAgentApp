"""Run task-owned Python against an AEDT copy; this module is not a Python sandbox.

Contract: apply(ipk, parameters) -> JSON object; verify(ipk, parameters) ->
{passed: bool, checks: nonempty list}. Verification runs after save/reopen.
Script-reported checks are recorded as such, never as independent host proof.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import shutil
from pathlib import Path
from typing import Any

from .managed import track_session
from .project import (_AEDT_START_LOCK, _without_agent_secrets, _default_icepak_factory,
                      _sha256_file, _validate_source, _project_metadata, _report)


class DynamicScriptError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _json_object(value: Any, label: str) -> dict:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    encoded = json.dumps(value, allow_nan=False, ensure_ascii=False)
    if len(encoded.encode("utf-8")) > 1024 * 1024:
        raise ValueError(f"{label} exceeds 1 MiB")
    return json.loads(encoded)


def run_dynamic_script(params: dict, *, icepak_factory=None, progress=None) -> dict:
    """Internal execution primitive. Core must supply a unique run dir and task authorization."""
    if not isinstance(params, dict):
        raise ValueError("params must be an object")
    for key in ("source", "scriptSha256", "projectPath", "projectSha256", "outputDir", "version"):
        if not isinstance(params.get(key), str) or not params[key].strip():
            raise ValueError(f"{key} must be a non-empty string")
    source_code = params["source"]
    if len(source_code.encode("utf-8")) > 128 * 1024:
        raise ValueError("script source exceeds 128 KiB")
    digest = hashlib.sha256(source_code.encode("utf-8")).hexdigest()
    if digest != params["scriptSha256"]:
        raise ValueError("script digest mismatch")
    parameters = _json_object(params.get("parameters", {}), "parameters")
    code = compile(source_code, f"dynamic-{digest}.py", "exec")
    original = Path(params["projectPath"]).expanduser().resolve()
    _validate_source(original, {})
    input_digest = _sha256_file(original)
    if input_digest != params["projectSha256"]:
        raise ValueError("source project digest mismatch")
    run_dir = Path(params["outputDir"]).expanduser().resolve()
    # Never reuse an existing run, including one with old evidence or symlinks.
    run_dir.mkdir(parents=True, exist_ok=False)
    working = run_dir / original.name
    shutil.copyfile(original, working)
    if _sha256_file(working) != input_digest:
        raise ValueError("project changed during copy")
    (run_dir / "script.py").write_text(source_code, encoding="utf-8")
    (run_dir / "parameters.json").write_text(json.dumps(parameters, ensure_ascii=False, indent=2), encoding="utf-8")
    report = {"schemaVersion": 1, "status": "running", "scriptSha256": digest,
              "inputSha256": input_digest, "sourceProject": str(original), "workingProject": str(working),
              "parameters": parameters, "executionKind": "test-double" if icepak_factory else "native-aedt",
              "scriptExecuted": False, "persistedReadback": False, "solve": {"hostRequested": False, "status": "not-verified"},
              "readbackEvidenceSource": "script-reported-after-reopen"}
    evidence = run_dir / "execution.json"

    def persist():
        temp = evidence.with_suffix(".tmp")
        temp.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
        temp.replace(evidence)

    persist()
    ipk = None
    try:
        _report(progress, "dynamic_script_loading")
        # Script print output must not corrupt the newline-delimited RPC protocol.
        with (run_dir / "script.log").open("w", encoding="utf-8") as log, contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
            namespace = {"__name__": "thermal_dynamic_operation", "__file__": str(run_dir / "script.py")}
            exec(code, namespace)
            if not callable(namespace.get("apply")) or not callable(namespace.get("verify")):
                raise ValueError("script must define apply(ipk, parameters) and verify(ipk, parameters)")
            with _AEDT_START_LOCK, _without_agent_secrets():
                factory = icepak_factory or _default_icepak_factory
                ipk = factory(project=str(working), version=params["version"], design=params.get("design"),
                              new_desktop=True, non_graphical=True)
            track_session(ipk)
            report["project"] = _project_metadata(ipk)
            _report(progress, "dynamic_script_applying")
            report["output"] = _json_object(namespace["apply"](ipk, json.loads(json.dumps(parameters))), "apply result")
            report["scriptExecuted"] = True
            verified = run_dir / "verified" / original.name
            verified.parent.mkdir()
            if ipk.save_project(file_name=str(verified), overwrite=False) is False or not verified.is_file():
                raise DynamicScriptError("SCRIPT_SAVE_FAILED", "modified project could not be saved")
            ipk.close_project(save=False)
            if ipk.load_project(str(verified), design=report["project"]["activeDesign"]) is False:
                raise DynamicScriptError("SCRIPT_REOPEN_FAILED", "saved project could not be reopened")
            readback = _json_object(namespace["verify"](ipk, json.loads(json.dumps(parameters))), "verify result")
            report["readback"] = readback
            if readback.get("passed") is not True or not isinstance(readback.get("checks"), list) or not readback["checks"]:
                raise DynamicScriptError("SCRIPT_READBACK_FAILED", "script verification did not pass with readback checks")
            report["persistedReadback"] = True
            report["verifiedProjectPath"] = str(verified)
            report["verifiedProjectSha256"] = _sha256_file(verified)
        report["status"] = "ok"
    except BaseException as exc:
        report["status"] = "failed"
        report["error"] = {"code": getattr(exc, "code", type(exc).__name__.upper()), "message": str(exc)[:1000]}
        raise DynamicScriptError(report["error"]["code"], report["error"]["message"]) from exc
    finally:
        try:
            if ipk is not None:
                try:
                    ipk.close_project(save=False)
                finally:
                    ipk.release_desktop(close_projects=False, close_desktop=True)
        except Exception as exc:
            report["status"] = "failed"
            report["cleanupError"] = str(exc)[:1000]
            raise DynamicScriptError("SCRIPT_CLEANUP_FAILED", str(exc)[:1000]) from exc
        finally:
            persist()
    _report(progress, "dynamic_script_readback_completed")
    return {**report, "evidencePath": str(evidence), "logPath": str(run_dir / "script.log")}

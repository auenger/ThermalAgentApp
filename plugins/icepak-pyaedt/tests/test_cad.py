"""Independent persisted test-double projects for CAD/model preparation contracts."""
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from thermal_icepak_plugin.cad import inspect_cad, ModelPreparationError
from thermal_icepak_plugin.model_preparation import prepare_model
from thermal_icepak_plugin.model_validation import validate_model
from thermal_icepak_plugin.__main__ import handle_request


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class Obj:
    def __init__(self, state):
        self.state = state
    @property
    def object_type(self): return self.state["type"]
    @property
    def bounding_box(self): return self.state["bounds"]
    @property
    def volume(self): return self.state["volume"]
    @property
    def material_name(self): return self.state["material"]
    @property
    def faces(self): return [SimpleNamespace(id=n) for n in range(10, 16)]
    @property
    def solve_inside(self): return self.state.get("solveInside", False)
    @solve_inside.setter
    def solve_inside(self, value): self.state["solveInside"] = value


class Modeler:
    model_units = "mm"
    user_defined_components = {}
    def __init__(self, state): self.state = state
    @property
    def object_names(self): return list(self.state["objects"])
    def __getitem__(self, name): return Obj(self.state["objects"][name])
    def delete(self, name): del self.state["objects"][name]; return True
    def create_region(self, *, pad_value, pad_type, name):
        objects = list(self.state["objects"].values())
        p = [float(str(v).removesuffix("mm")) for v in pad_value]
        self.state["objects"][name] = {"type": "Solid", "volume": 1000, "material": "air", "solveInside": True,
          "bounds": [min(o["bounds"][i] for o in objects) - p[2*i] for i in range(3)] + [max(o["bounds"][i+3] for o in objects) + p[2*i] for i in range(3)]}
        return self[name]


class Boundary:
    def __init__(self, record): self.record = record; self.name = record["name"]; self.type = record["type"]; self.props = record["props"]
    def update(self): return True


class Fake:
    aedt_version_id = "2024.2"
    design_name = "IcepakDesign1"
    native_components = {}
    instances = []
    def __init__(self, **args):
        self.closed = False
        self.released = False
        self.path = Path(args["project"])
        self.state = json.loads(self.path.read_text()) if self.path.exists() else {"objects": {}, "boundaries": [], "monitors": {}, "setup": {}, "settings": {}, "meshLevel": 3, "meshOps": []}
        self.modeler = Modeler(self.state)
        self.monitor = SimpleNamespace(assign_point_monitor_in_object=self.assign_monitor)
        self.monitor.all_monitors = {name: SimpleNamespace(geometry_assignment=record["object"], quantities=["Temperature"]) for name, record in self.state["monitors"].items()}
        global_mesh = SimpleNamespace(manual_settings=False, settings={"MeshRegionResolution": self.state["meshLevel"]}, update=lambda: True)
        self.mesh = SimpleNamespace(global_mesh_region=global_mesh, assign_mesh_level=self.assign_mesh,
          meshoperations=[SimpleNamespace(name=op["name"], props=op["props"]) for op in self.state["meshOps"]], generate_mesh=lambda **kw: True)
        self.design_settings = self.state["settings"]
        Fake.instances.append(self)
    @property
    def boundaries(self): return [Boundary(b) for b in self.state["boundaries"]]
    @property
    def setup_names(self): return ["ThermalBaseline"] if self.state["setup"] else []
    def import_3d_cad(self, path, **options):
        if Path(path).read_text() == "invalid": return False
        self.state["objects"] = {
          "CPU": {"type": "Solid", "bounds": [5,5,0,15,15,2], "volume": 200, "material": "vacuum"},
          "Sink": {"type": "Solid", "bounds": [0,0,2,30,30,12], "volume": 9000, "material": "vacuum"}}
        return True
    def assign_material(self, name, material): self.state["objects"][name]["material"] = material; return True
    def assign_solid_block(self, name, power, boundary_name):
        record = {"name": boundary_name, "type": "Block", "props": {"Objects": [name], "Block Type": "Solid", "Total Power": power}}
        self.state["boundaries"].append(record); return Boundary(record)
    def assign_openings(self, faces):
        record = {"name": "Opening1", "type": "Opening", "props": {"Faces": faces, "Inlet Type": "Pressure", "Temperature": "AmbientTemp"}}
        self.state["boundaries"].append(record); return Boundary(record)
    def assign_monitor(self, name, **options):
        monitor_name = options["monitor_name"]
        self.state["monitors"][monitor_name] = {"object": name}
        return monitor_name
    def edit_design_settings(self, gravity_dir, ambient_temperature, **options):
        self.state["settings"].update(AmbTemp=f"{ambient_temperature}cel", GravityVec=f"Global::{['X','Y','Z'][gravity_dir % 3]}", GravityDir="Negative" if gravity_dir < 3 else "Positive")
        return True
    def create_setup(self, **options): return SimpleNamespace(update=lambda props: self.state["setup"].update(props) or True)
    def get_setup(self, name): return SimpleNamespace(props=self.state["setup"])
    def assign_mesh(self, mesh_order, name):
        self.state["meshOps"] = [{"name": name, "props": {"Level": next(iter(mesh_order.values())), "Objects": list(mesh_order)}}]
        return [name]
    def save_project(self, file_name, overwrite):
        self.state["meshLevel"] = self.mesh.global_mesh_region.settings["MeshRegionResolution"]
        Path(file_name).write_text(json.dumps(self.state)); return True
    def export_design_preview_to_jpg(self, path): return False
    def validate_simple(self, log_file): Path(log_file).write_text("test-double geometry validation"); return 1
    def export_mesh_stats(self, setup, output_file): Path(output_file).write_text("test-double mesh statistics"); return output_file
    def close_project(self, save): self.closed = True
    def release_desktop(self, **options): self.released = True


def confirmed_spec(catalog):
    def val(value): return {"value": value, "source": "USER_INPUT", "reference": "engineering test fixture", "confirmed": True}
    return {"schemaVersion": 1, "templateId": "steady-natural-convection-v1", "templateVersion": 1,
      "sourceSha256": catalog["sourceSha256"], "inspectionId": catalog["inspectionId"], "catalogSha256": "b"*64,
      "units": "mm", "aedtVersion": "2024.2", "dimensionsConfirmed": True, "assumptionsConfirmed": True,
      "contactNotes": "CPU directly touches sink", "author": "engineer", "reason": "reference case", "targetTmaxC": 85,
      "objects": [{"objectKey": o["key"], "included": True, "role": "HEAT_SOURCE" if o["name"] == "CPU" else "HEATSINK",
        "material": val("silicon" if o["name"] == "CPU" else "aluminum"), "powerW": val(10 if o["name"] == "CPU" else 0), "monitor": True, "exclusionReason": ""} for o in catalog["objects"]],
      "ambientTemperatureC": val(25), "gravity": val("-Z"), "regionPaddingPercent": val(100), "regionMinPaddingMm": val(20),
      "meshLevel": val(4), "maxIterations": val(500), "flowConvergence": val(0.001), "energyConvergence": val(1e-7)}


class CadPreparationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        self.source = self.root / "sample.step"; self.source.write_text("valid test-double STEP")
        Fake.instances = []
    def tearDown(self): self.tmp.cleanup()
    def imported(self):
        return inspect_cad(source_path=str(self.source), source_sha256=digest(self.source), inspection_id="inspection-1", output_dir=str(self.root / "import"), version="2024.2", icepak_factory=Fake)
    def generated(self):
        result = self.imported(); spec = confirmed_spec(result["catalog"])
        generated = prepare_model(project_path=result["projectPath"], project_sha256=digest(result["projectPath"]), catalog=result["catalog"], spec=spec, spec_sha256="a"*64, output_dir=str(self.root / "prepare"), icepak_factory=Fake)
        return generated, result["catalog"], spec
    def validated(self, generated, catalog, spec):
        return validate_model(project_path=generated["projectPath"], project_sha256=digest(generated["projectPath"]), catalog=catalog, spec=spec, spec_sha256="a"*64, output_dir=str(self.root / "validate"), icepak_factory=Fake)
    def test_import_preserves_source_and_returns_geometry_catalog_without_solver(self):
        original = self.source.read_bytes(); result = self.imported()
        self.assertEqual(self.source.read_bytes(), original)
        self.assertEqual({o["name"] for o in result["catalog"]["objects"]}, {"CPU", "Sink"})
        self.assertEqual(result["catalog"]["units"], "mm")
        self.assertTrue(Fake.instances[-1].closed and Fake.instances[-1].released)
    def test_fresh_persisted_model_roundtrip_reads_materials_power_gravity_and_mesh(self):
        generated, catalog, spec = self.generated()
        original = Path(generated["projectPath"]).read_bytes()
        result = self.validated(generated, catalog, spec)
        self.assertTrue(result["validation"]["verified"])
        self.assertEqual(result["validation"]["actual"]["gravity"], "-Z")
        self.assertEqual(result["validation"]["actual"]["meshLevel"], 4)
        self.assertEqual(len(Fake.instances), 3)
        self.assertEqual(Path(generated["projectPath"]).read_bytes(), original)
    def test_persisted_wrong_material_is_rejected_even_with_valid_input_hash(self):
        generated, catalog, spec = self.generated()
        path = Path(generated["projectPath"]); state = json.loads(path.read_text()); state["objects"]["CPU"]["material"] = "copper"; path.write_text(json.dumps(state))
        with self.assertRaisesRegex(ModelPreparationError, "材料不一致"): self.validated(generated, catalog, spec)
        self.assertTrue(Fake.instances[-1].released)
    def test_missing_confirmation_prevents_any_aedt_mutation(self):
        imported = self.imported(); spec = confirmed_spec(imported["catalog"]); spec["objects"][0]["material"]["confirmed"] = False
        with self.assertRaisesRegex(ModelPreparationError, "材料"):
            prepare_model(project_path=imported["projectPath"], project_sha256=digest(imported["projectPath"]), catalog=imported["catalog"], spec=spec, spec_sha256="a"*64, output_dir=str(self.root / "prepare"), icepak_factory=Fake)
        self.assertEqual(len(Fake.instances), 1)
    def test_corrupt_import_and_wrong_hash_return_specific_failures(self):
        with self.assertRaisesRegex(ModelPreparationError, "SHA256"):
            inspect_cad(source_path=str(self.source), source_sha256="0"*64, inspection_id="a", output_dir=str(self.root / "bad"), version="2024.2", icepak_factory=Fake)
        self.source.write_text("invalid")
        with self.assertRaisesRegex(ModelPreparationError, "导入失败"): self.imported()
        self.assertTrue(Fake.instances[-1].released)
    def test_protocol_rejects_incomplete_model_requests(self):
        for method in ("inspect_cad", "prepare_model", "validate_model"):
            result = handle_request({"id": "req", "method": method, "params": {}})
            self.assertFalse(result["ok"]); self.assertEqual(result["id"], "req")


if __name__ == "__main__": unittest.main()

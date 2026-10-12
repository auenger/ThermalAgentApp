"""Parameter edits must survive serialization and an independent reload, not a cached read."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from test_plugin import _FakeIcepak, _Fan, _Named
from thermal_icepak_plugin.parameters import discover_parameters, validate_changes
from thermal_icepak_plugin.project import run_project_operation


class VariableManager:
    def __init__(self):
        self.variables = {
            'FinGap': SimpleNamespace(expression='2mm', read_only=False),
            '$Power': SimpleNamespace(expression='20W', read_only=False),
            'Derived': SimpleNamespace(expression='FinGap*2', read_only=False),
            'Locked': SimpleNamespace(expression='1mm', read_only=True),
            'Unused': SimpleNamespace(expression='1mm', read_only=False),
        }
        self.writes = []

    def is_used(self, name):
        return name != 'Unused'

    def set_variable(self, name, expression):
        self.writes.append((name, expression))
        self.variables[name].expression = expression
        return True


class Boundary(_Named):
    def update(self):
        return True


class Modeler:
    object_names = ['Sink', 'Air']

    def __init__(self):
        self.objects = {'Sink': SimpleNamespace(material_name='aluminum', is3d=True), 'Air': SimpleNamespace(material_name='air', is3d=True)}

    def __getitem__(self, name):
        return self.objects[name]


class PersistedIcepak(_FakeIcepak):
    def __init__(self, corrupt=False, reopen=False):
        super().__init__()
        self.variable_manager = VariableManager()
        self.modeler = Modeler()
        self.materials = SimpleNamespace(material_keys={'aluminum': object(), 'copper': object(), 'air': object()})
        self.boundaries.append(Boundary('CPU', 'Block', {'Total Power': '20W'}))
        self.native_components['Fan2'] = _Fan()
        self.corrupt = corrupt
        self.fail_reopen = reopen
        self.reloaded = False

    def assign_material(self, name, value):
        self.modeler[name].material_name = value
        return True

    def save_project(self, file_name, overwrite):
        Path(file_name).write_text(json.dumps({
            'variables': {k: v.expression for k, v in self.variable_manager.variables.items()},
            'materials': {k: v.material_name for k, v in self.modeler.objects.items()},
            'boundaries': [b.props for b in self.boundaries],
            'fans': {k: f.native_properties for k, f in self.native_components.items()},
        }))
        return True

    def load_project(self, path, design):
        if self.fail_reopen:
            return False
        data = json.loads(Path(path).read_text())
        self.variable_manager = VariableManager()
        for k, v in data['variables'].items():
            self.variable_manager.variables[k].expression = v
        if self.corrupt:
            self.variable_manager.variables['FinGap'].expression = '2mm'
        self.modeler = Modeler()
        for k, v in data['materials'].items():
            self.modeler[k].material_name = v
        for b, props in zip(self.boundaries, data['boundaries']):
            b.props = props
        for k, props in data['fans'].items():
            self.native_components[k] = _Fan()
            self.native_components[k].native_properties = props
        self.reloaded = True
        return True


def change(ipk, key, value, role='design'):
    descriptor = next(p for p in discover_parameters(ipk) if p['id'] == key)
    return {'parameter': descriptor, 'value': value, 'role': role}


class ParameterTests(unittest.TestCase):
    def run_check(self, ipk, edits):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'source.aedt'
            source.write_text('original')
            result = run_project_operation(source, Path(root) / 'run', mode='check-changes', changes=edits, icepak_factory=lambda **_: ipk)
            self.assertEqual(source.read_text(), 'original')
            self.assertTrue(Path(result['verifiedProjectPath']).is_file())
            return result

    def test_mixed_batch_is_persisted_and_reopened_without_solving(self):
        ipk = PersistedIcepak()
        edits = [change(ipk, 'variable:FinGap', '1.5mm'), change(ipk, 'material:Sink', 'copper'),
                 change(ipk, 'boundary-power:CPU', '25W', 'operating-condition'), change(ipk, 'fan:Fan1', '1.1')]
        untouched = copy.deepcopy(ipk.native_components['Fan2'].native_properties)
        result = self.run_check(ipk, edits)
        self.assertTrue(ipk.reloaded)
        self.assertEqual(ipk.analyze_calls, [])
        self.assertIn('persistedParameters', result['validation']['checks'])
        self.assertTrue(all(a['verified'] for a in result['actionResults']))
        self.assertEqual(result['actionResults'][0]['verifiedAfter'], '1.5mm')
        self.assertEqual(ipk.native_components['Fan2'].native_properties, untouched)
        self.assertTrue(ipk.closed and ipk.released)

    def test_lost_write_on_reopen_fails(self):
        ipk = PersistedIcepak(corrupt=True)
        with self.assertRaisesRegex(RuntimeError, 'persisted parameter verification failed'):
            self.run_check(ipk, [change(ipk, 'variable:FinGap', '1mm')])
        self.assertEqual(ipk.analyze_calls, [])

    def test_reopen_failure_is_not_a_success(self):
        ipk = PersistedIcepak(reopen=True)
        with self.assertRaisesRegex(RuntimeError, 'reopen failed'):
            self.run_check(ipk, [change(ipk, 'variable:FinGap', '1mm')])

    def test_entire_batch_validated_before_any_write(self):
        ipk = PersistedIcepak()
        with self.assertRaisesRegex(ValueError, 'numeric value'):
            self.run_check(ipk, [change(ipk, 'variable:FinGap', '1mm'), change(ipk, 'boundary-power:CPU', '5mm', 'operating-condition')])
        self.assertEqual(ipk.variable_manager.writes, [])

    def test_stale_parameter_and_duplicate_are_rejected(self):
        ipk = PersistedIcepak()
        edit = change(ipk, 'variable:FinGap', '1mm')
        with self.assertRaisesRegex(ValueError, 'duplicated'):
            validate_changes(ipk, [edit, edit])
        ipk.variable_manager.variables['FinGap'].expression = '3mm'
        with self.assertRaisesRegex(ValueError, 'changed since inspection'):
            validate_changes(ipk, [edit])

    def test_power_cannot_be_classified_as_design(self):
        ipk = PersistedIcepak()
        for key in ['variable:$Power', 'boundary-power:CPU']:
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'separate baseline'):
                validate_changes(ipk, [change(ipk, key, '10W')])

    def test_inventory_excludes_expressions_locked_unused_and_air_objects(self):
        ids = {p['id'] for p in discover_parameters(PersistedIcepak())}
        self.assertEqual(ids, {'variable:FinGap', 'variable:$Power', 'material:Sink', 'boundary-power:CPU', 'fan:Fan1', 'fan:Fan2'})

    def test_prepared_project_solve_compares_against_original_baseline(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'prepared.aedt'
            source.write_text('verified project')
            ipk = _FakeIcepak(maximum=90)
            result = run_project_operation(source, Path(root) / 'run', mode='solve',
                                           baseline_metrics={'tmaxC': 95}, icepak_factory=lambda **_: ipk)
            self.assertEqual(result['comparison']['deltaTmaxC'], -5)
            self.assertTrue(result['comparison']['improved'])
            self.assertEqual(ipk.native_components['Fan1'].update_calls, 0)

    def test_invalid_material_range_and_nonfinite_are_rejected(self):
        ipk = PersistedIcepak()
        for key, value in [('material:Sink', 'unknown'), ('variable:FinGap', '-1mm'), ('variable:FinGap', '1e999mm'), ('fan:Fan1', '1.6')]:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                validate_changes(ipk, [change(ipk, key, value)])

    def test_scalar_noop_is_rejected(self):
        ipk = PersistedIcepak()
        with self.assertRaisesRegex(ValueError, 'unchanged'):
            validate_changes(ipk, [change(ipk, 'variable:FinGap', '2.000mm')])


if __name__ == '__main__':
    unittest.main()

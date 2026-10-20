"""Dynamic operation lifecycle tests. Fake AEDT is not native engineering evidence."""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from thermal_icepak_plugin.dynamic_script import run_dynamic_script, DynamicScriptError
from thermal_icepak_plugin.__main__ import handle_request

SCRIPT = '''
def apply(ipk, parameters):
    print("changing heat source")
    ipk.power = parameters["powerW"]
    return {"powerW": ipk.power}
def verify(ipk, parameters):
    return {"passed": ipk.power == parameters["powerW"], "checks": [{"actualW": ipk.power}]}
'''


class FakeIcepak:
    design_name = 'Thermal'
    aedt_version_id = '2024.2'
    def __init__(self, *, project, **kwargs):
        self.path = Path(project)
        self.power = json.loads(self.path.read_text())['power']
        self.reopened = False
        self.released = False
        self.lose_write = False
        self.fail_save = False

    def save_project(self, *, file_name, overwrite):
        if self.fail_save:
            return False
        Path(file_name).write_text(json.dumps({'power': 1 if self.lose_write else self.power}))
        return True

    def close_project(self, *, save):
        self.power = None  # ensure verify cannot rely on the mutated in-memory object

    def load_project(self, path, *, design):
        self.power = json.loads(Path(path).read_text())['power']
        self.reopened = True
        return True

    def release_desktop(self, **kwargs):
        self.released = True


class DynamicScriptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='Thermal dynamic script ')
        self.root = Path(self.temp.name)
        self.original = self.root / 'Source project.aedt'
        self.original.write_text('{"power": 1}')
        self.sessions = []

    def tearDown(self):
        self.temp.cleanup()

    def params(self, code=SCRIPT):
        return {'source': code, 'scriptSha256': hashlib.sha256(code.encode()).hexdigest(),
                'parameters': {'powerW': 20}, 'projectPath': str(self.original),
                'projectSha256': hashlib.sha256(self.original.read_bytes()).hexdigest(),
                'outputDir': str(self.root / 'run with spaces'), 'version': '2024.2'}

    def factory(self, **kwargs):
        instance = FakeIcepak(**kwargs)
        self.sessions.append(instance)
        return instance

    def test_dynamic_heat_source_operation_persists_and_reopens(self):
        result = run_dynamic_script(self.params(), icepak_factory=self.factory)
        self.assertEqual(result['status'], 'ok')
        self.assertTrue(result['persistedReadback'])
        self.assertEqual(result['executionKind'], 'test-double')
        self.assertEqual(result['readbackEvidenceSource'], 'script-reported-after-reopen')
        self.assertEqual(result['solve'], {'hostRequested': False, 'status': 'not-verified'})
        self.assertTrue(self.sessions[0].reopened)
        self.assertTrue(self.sessions[0].released)
        self.assertEqual(json.loads(self.original.read_text()), {'power': 1})
        self.assertEqual(json.loads(Path(result['verifiedProjectPath']).read_text()), {'power': 20})
        self.assertIn('changing heat source', Path(result['logPath']).read_text())
        self.assertEqual(json.loads(Path(result['evidencePath']).read_text())['status'], 'ok')

    def test_lost_persisted_change_fails_readback_and_releases(self):
        def factory(**kwargs):
            instance = self.factory(**kwargs)
            instance.lose_write = True
            return instance
        with self.assertRaisesRegex(DynamicScriptError, 'verification did not pass'):
            run_dynamic_script(self.params(), icepak_factory=factory)
        report = json.loads((self.root / 'run with spaces' / 'execution.json').read_text())
        self.assertEqual(report['error']['code'], 'SCRIPT_READBACK_FAILED')
        self.assertFalse(report['persistedReadback'])
        self.assertTrue(self.sessions[0].released)

    def test_digest_mismatch_never_launches(self):
        for key in ('scriptSha256', 'projectSha256'):
            params = self.params()
            params[key] = '0' * 64
            with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                run_dynamic_script(params, icepak_factory=self.factory)
        self.assertEqual(self.sessions, [])
        self.assertFalse((self.root / 'run with spaces').exists())

    def test_existing_output_is_not_overwritten(self):
        run_dynamic_script(self.params(), icepak_factory=self.factory)
        with self.assertRaises(FileExistsError):
            run_dynamic_script(self.params(), icepak_factory=self.factory)
        self.assertEqual(len(self.sessions), 1)

    def test_script_exception_is_recorded_and_session_released(self):
        code = SCRIPT.replace('ipk.power = parameters["powerW"]', 'raise TypeError("unsupported API")')
        with self.assertRaisesRegex(DynamicScriptError, 'unsupported API'):
            run_dynamic_script(self.params(code), icepak_factory=self.factory)
        report = json.loads((self.root / 'run with spaces' / 'execution.json').read_text())
        self.assertEqual(report['error']['code'], 'TYPEERROR')
        self.assertFalse(report['scriptExecuted'])
        self.assertTrue(self.sessions[0].released)

    def test_failed_save_does_not_claim_readback(self):
        def factory(**kwargs):
            instance = self.factory(**kwargs)
            instance.fail_save = True
            return instance
        with self.assertRaises(DynamicScriptError) as failure:
            run_dynamic_script(self.params(), icepak_factory=factory)
        self.assertEqual(failure.exception.code, 'SCRIPT_SAVE_FAILED')
        self.assertFalse(self.sessions[0].reopened)
        self.assertTrue(self.sessions[0].released)

    def test_rpc_preserves_failure_code(self):
        with patch('thermal_icepak_plugin.__main__.run_dynamic_script', side_effect=DynamicScriptError('SCRIPT_READBACK_FAILED', 'changed value missing')):
            response = handle_request({'id': 'run', 'method': 'execute_script', 'params': self.params()})
        self.assertFalse(response['ok'])
        self.assertEqual(response['error']['code'], 'SCRIPT_READBACK_FAILED')

    def test_missing_entrypoints_do_not_launch(self):
        with self.assertRaisesRegex(DynamicScriptError, 'must define apply'):
            run_dynamic_script(self.params('print("hello")'), icepak_factory=self.factory)
        self.assertFalse(self.sessions)


if __name__ == '__main__':
    unittest.main()

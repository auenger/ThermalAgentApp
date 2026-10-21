import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from thermal_icepak_plugin import __main__ as rpc


class PreloadTests(unittest.TestCase):
    def test_managed_preload_precedes_watchers_and_preserves_protocol(self):
        order = []
        output, diagnostics = io.StringIO(), io.StringIO()
        def imported(name):
            order.append('import')
            print('native import diagnostic')
        def started(*args):
            order.append('watchers')
            return object()
        request = json.dumps({'id': 'probe', 'method': 'probe_launchability'})
        with patch.object(rpc.sys, 'platform', 'win32'), patch.dict(rpc.os.environ, {'THERMAL_ICEPAK_MANAGED_ONESHOT':'1', 'THERMAL_ICEPAK_PARENT_PID':'123'}), patch.object(rpc, 'read_managed_request', return_value=(request, iter(()))), patch.object(rpc.importlib, 'import_module', side_effect=imported), patch.object(rpc, 'start_managed', side_effect=started), patch.object(rpc, 'finish_managed'), patch.object(rpc, 'handle_request', return_value={'id':'probe','ok':True}), patch.object(rpc.sys, 'stdout', output), patch.object(rpc.sys, 'stderr', diagnostics):
            self.assertEqual(rpc.main(), 0)
        self.assertEqual(order, ['import', 'watchers'])
        lines = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([line.get('stage') for line in lines[:-1]], ['pyaedt_preloading','pyaedt_preloaded'])
        self.assertIn('native import diagnostic', diagnostics.getvalue())

    def test_health_stays_lightweight_and_import_failure_is_not_swallowed(self):
        with patch.object(rpc.sys, 'platform', 'win32'), patch.object(rpc.importlib, 'import_module', side_effect=ImportError('missing extension')) as imported:
            rpc.preload_engineering({'method':'health'}, lambda stage: None)
            rpc.preload_engineering({'method':'probe_environment'}, lambda stage: None)
            imported.assert_not_called()
            with self.assertRaisesRegex(ImportError, 'missing extension'):
                rpc.preload_engineering({'method':'execute_script'}, lambda stage: None)

    def test_native_aedt_environment_key_is_returned_as_semantic_version(self):
        from types import SimpleNamespace
        from thermal_icepak_plugin.project import _project_metadata
        self.assertEqual(_project_metadata(SimpleNamespace(aedt_version_id='ANSYSEM_ROOT242'))['aedtVersion'], '2024.2')

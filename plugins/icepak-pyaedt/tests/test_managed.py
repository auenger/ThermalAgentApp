from __future__ import annotations

import ctypes
import json
import os
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from thermal_icepak_plugin.managed import ManagedLifecycle, read_managed_request
from thermal_icepak_plugin.windows_job import ExtendedLimits, WindowsJob


class MissingProcess(Exception): pass
class WaitTimeout(Exception): pass


class FakeProcess:
    def __init__(self, oracle, pid): self.oracle = oracle; self.pid = pid
    def create_time(self): return self.oracle.records[self.pid]['created']
    def is_running(self): return self.oracle.records[self.pid]['alive']
    def status(self): return 'running' if self.is_running() else 'zombie'
    def children(self, recursive): return [self.oracle.Process(pid) for pid in self.oracle.records[self.pid].get('children', [])]
    def kill(self):
        if self.oracle.records[self.pid].get('denied'): raise PermissionError('access denied')
        self.oracle.killed.append(self.pid); self.oracle.records[self.pid]['alive'] = False
    def wait(self, timeout): return 0


class Oracle:
    NoSuchProcess = MissingProcess
    TimeoutExpired = WaitTimeout
    STATUS_ZOMBIE = 'zombie'
    def __init__(self):
        self.records = {11: {'created': 10, 'alive': True}, 22: {'created': 20, 'alive': True, 'children': [23]}, 23: {'created': 21, 'alive': True}}
        self.killed = []
    def Process(self, pid):
        if pid not in self.records: raise MissingProcess()
        return FakeProcess(self, pid)


class Function:
    def __init__(self, callback): self.callback = callback
    def __call__(self, *args): return self.callback(*args)


class Kernel:
    def __init__(self, *, member=True, config_ok=True, birth=100.0):
        self.assigned = []; self.closed = []; self.flags = None; self.size = None
        self.CreateJobObjectW = Function(lambda *args: 17)
        self.GetCurrentProcess = Function(lambda: 7)
        self.OpenProcess = Function(lambda *args: 8)
        self.CloseHandle = Function(lambda handle: self.closed.append(handle) or 1)
        self.AssignProcessToJobObject = Function(lambda job, process: self.assigned.append((job, process)) or 1)
        def configure(handle, info_type, pointer, size):
            self.flags = pointer._obj.BasicLimitInformation.LimitFlags; self.size = size
            return int(config_ok)
        self.SetInformationJobObject = Function(configure)
        def membership(process, job, pointer): pointer._obj.value = int(member); return 1
        self.IsProcessInJob = Function(membership)
        def times(process, created, *unused):
            raw = int((birth + 11644473600) * 10000000)
            created._obj.low = raw & 0xffffffff; created._obj.high = raw >> 32; return 1
        self.GetProcessTimes = Function(times)


class ManagedLifetimeTests(unittest.TestCase):
    def lifecycle(self):
        oracle = Oracle(); reported = []
        with patch('thermal_icepak_plugin.managed.os.name', 'posix'):
            guard = ManagedLifecycle(11, lambda pid, birth: reported.append((pid, birth)), process_module=oracle)
        return guard, oracle, reported
    def test_registered_session_and_children_are_reaped(self):
        guard, oracle, reported = self.lifecycle(); guard.track(22)
        self.assertEqual(reported, [(22, 20)])
        self.assertTrue(guard.cleanup()); self.assertEqual(oracle.killed, [23, 22])
    def test_reused_pid_is_never_killed(self):
        guard, oracle, _ = self.lifecycle(); guard.track(22)
        oracle.records[22]['created'] = 999
        self.assertTrue(guard.cleanup()); self.assertEqual(oracle.killed, [])
        self.assertTrue(oracle.records[22]['alive'])
    def test_unconfirmed_cleanup_keeps_resource_identity(self):
        guard, oracle, _ = self.lifecycle(); guard.track(22); oracle.records[22]['denied'] = True
        self.assertFalse(guard.cleanup()); self.assertEqual(guard.resources[22], 20)
    def test_parent_birth_change_is_detected(self):
        guard, oracle, _ = self.lifecycle(); oracle.records[11]['created'] = 500
        self.assertFalse(guard.alive(11, guard.parent_created))
    def test_cancellation_control_reaps_before_worker_exit(self):
        guard, oracle, _ = self.lifecycle(); guard.track(22)
        stopped = threading.Event()
        def exited(code):
            self.assertFalse(oracle.records[22]['alive']); self.assertEqual(code, 75)
            guard.finished.set(); stopped.set()
        guard.exit_process = exited
        guard.start(iter(['{"event":"cancel"}\n']))
        self.assertTrue(stopped.wait(2))
    def test_raw_request_reader_preserves_utf8_and_buffered_cancel(self):
        reader, writer = os.pipe()
        try:
            os.write(writer, '{"id":"中文"}\n{"event":"cancel"}\n'.encode('utf-8')); os.close(writer); writer = None
            with os.fdopen(reader, 'rb', buffering=0) as stream:
                request, controls = read_managed_request(stream)
                self.assertEqual(json.loads(request)['id'], '中文')
                self.assertEqual(json.loads(next(controls))['event'], 'cancel')
                self.assertEqual(list(controls), [])
        finally:
            if writer is not None: os.close(writer)


class WindowsJobAdapterTests(unittest.TestCase):
    def test_kernel_boundary_sets_kill_on_close_and_includes_worker(self):
        kernel = Kernel(); job = WindowsJob(kernel)
        self.assertEqual(kernel.flags, 0x2000)
        if ctypes.sizeof(ctypes.c_void_p) == 8: self.assertEqual(ctypes.sizeof(ExtendedLimits), 144)
        self.assertEqual(kernel.assigned, [(17, 7)])
        job.include_process(22, 100.0)
        self.assertEqual(kernel.assigned, [(17, 7)])
        self.assertEqual(kernel.closed, [8])
    def test_nonmember_is_explicitly_assigned(self):
        kernel = Kernel(member=False); WindowsJob(kernel).include_process(22, 100.0)
        self.assertEqual(kernel.assigned, [(17, 7), (17, 8)])
    def test_configuration_failure_does_not_assign_worker(self):
        kernel = Kernel(config_ok=False)
        with self.assertRaisesRegex(RuntimeError, 'kill-on-close'): WindowsJob(kernel)
        self.assertEqual(kernel.assigned, []); self.assertEqual(kernel.closed, [17])
    def test_pid_birth_mismatch_prevents_assignment(self):
        kernel = Kernel(member=False, birth=200.0); job = WindowsJob(kernel)
        with self.assertRaisesRegex(RuntimeError, 'birth identity changed'): job.include_process(22, 100.0)
        self.assertEqual(kernel.assigned, [(17, 7)]); self.assertEqual(kernel.closed, [8])


if __name__ == '__main__': unittest.main()

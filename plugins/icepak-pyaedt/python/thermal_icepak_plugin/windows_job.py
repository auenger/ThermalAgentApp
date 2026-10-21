"""Windows kernel lifetime boundary for a one-shot Python worker and its children.

Ref: https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
The handle intentionally stays open until worker process exit. KILL_ON_JOB_CLOSE
then applies even when the worker is forcibly terminated before Python cleanup.
"""
from __future__ import annotations

import math
import ctypes
from ctypes import c_int32, c_uint32, c_uint64, c_size_t, c_void_p, c_wchar_p


class BasicLimits(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", c_uint32), ("MinimumWorkingSetSize", c_size_t), ("MaximumWorkingSetSize", c_size_t),
                ("ActiveProcessLimit", c_uint32), ("Affinity", c_size_t), ("PriorityClass", c_uint32), ("SchedulingClass", c_uint32)]


class IoCounters(ctypes.Structure):
    _fields_ = [(name, c_uint64) for name in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class ExtendedLimits(ctypes.Structure):
    _fields_ = [("BasicLimitInformation", BasicLimits), ("IoInfo", IoCounters),
                ("ProcessMemoryLimit", c_size_t), ("JobMemoryLimit", c_size_t), ("PeakProcessMemoryUsed", c_size_t), ("PeakJobMemoryUsed", c_size_t)]


class FileTime(ctypes.Structure):
    _fields_ = [("low", c_uint32), ("high", c_uint32)]


class WindowsJob:
    def __init__(self, kernel=None):
        self.kernel = kernel if kernel is not None else ctypes.WinDLL("kernel32", use_last_error=True)
        for name, args, result in (
            ("CreateJobObjectW", [c_void_p, c_wchar_p], c_void_p),
            ("SetInformationJobObject", [c_void_p, c_int32, c_void_p, c_uint32], c_int32),
            ("AssignProcessToJobObject", [c_void_p, c_void_p], c_int32),
            ("GetCurrentProcess", [], c_void_p),
            ("OpenProcess", [c_uint32, c_int32, c_uint32], c_void_p),
            ("CloseHandle", [c_void_p], c_int32),
            ("IsProcessInJob", [c_void_p, c_void_p, ctypes.POINTER(c_int32)], c_int32),
            ("GetProcessTimes", [c_void_p] + [ctypes.POINTER(FileTime)] * 4, c_int32),
        ):
            function = getattr(self.kernel, name)
            function.argtypes, function.restype = args, result
        self.handle = self.kernel.CreateJobObjectW(None, None)
        if not self.handle: raise RuntimeError("MANAGED_JOB_UNAVAILABLE: CreateJobObject failed")
        try:
            limits = ExtendedLimits()
            limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway flags.
            if not self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
                raise RuntimeError("MANAGED_JOB_UNAVAILABLE: kill-on-close configuration failed")
            if not self.kernel.AssignProcessToJobObject(self.handle, self.kernel.GetCurrentProcess()):
                raise RuntimeError("MANAGED_JOB_UNAVAILABLE: worker could not enter its job")
        except Exception:
            self.kernel.CloseHandle(self.handle)
            raise

    def include_process(self, pid: int, expected_creation_time: float):
        process = self.kernel.OpenProcess(0x0100 | 0x0001 | 0x0400, False, pid)
        if not process: raise RuntimeError("MANAGED_JOB_UNAVAILABLE: AEDT process handle unavailable")
        try:
            created, exited, kernel, user = FileTime(), FileTime(), FileTime(), FileTime()
            if not self.kernel.GetProcessTimes(process, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)):
                raise RuntimeError("MANAGED_JOB_UNAVAILABLE: AEDT process birth identity unavailable")
            # Subtract the FILETIME epoch as integers before converting to seconds.
            # A few float ULPs cover psutil's alternate arithmetic (~1 us at
            # contemporary epochs), without accepting a one-second PID mismatch.
            birth = (((created.high << 32) | created.low) - 116444736000000000) / 10000000
            tolerance = 4 * max(math.ulp(birth), math.ulp(expected_creation_time))
            if not math.isfinite(expected_creation_time) or abs(birth - expected_creation_time) > tolerance:
                raise RuntimeError("MANAGED_JOB_UNAVAILABLE: AEDT PID birth identity changed")
            in_job = c_int32()
            if not self.kernel.IsProcessInJob(process, self.handle, ctypes.byref(in_job)):
                raise RuntimeError("MANAGED_JOB_UNAVAILABLE: AEDT job membership could not be read")
            if not in_job.value and not self.kernel.AssignProcessToJobObject(self.handle, process):
                raise RuntimeError("MANAGED_JOB_UNAVAILABLE: AEDT session could not enter its job")
        finally:
            self.kernel.CloseHandle(process)

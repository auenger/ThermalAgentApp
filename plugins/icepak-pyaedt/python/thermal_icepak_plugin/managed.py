"""Lifetime guard for Core-owned workers and explicitly created AEDT sessions.

Managed requests are one-shot: stdin remains open as a cancellation channel.
PID creation times are checked before killing a registered session, so PID reuse
cannot turn recovery into termination of an unrelated process.
"""
from __future__ import annotations

import json
import os
import threading
import time
from typing import Any

_CURRENT = None


class ManagedLifecycle:
    def __init__(self, parent_pid: int, report_resource, *, process_module=None, exit_process=os._exit):
        if process_module is None:
            import psutil as process_module
        self.processes = process_module
        self.parent_pid = parent_pid
        self.parent_created = self.processes.Process(parent_pid).create_time()
        self.report_resource = report_resource
        self.exit_process = exit_process
        self.resources: dict[int, float] = {}
        self.lock = threading.RLock()
        self.cancelled = threading.Event()
        self.finished = threading.Event()
        self.job = None
        if os.name == 'nt':
            from .windows_job import WindowsJob
            self.job = WindowsJob()

    def alive(self, pid: int, creation_time: float) -> bool:
        try:
            process = self.processes.Process(pid)
            return process.create_time() == creation_time and process.is_running() and process.status() != self.processes.STATUS_ZOMBIE
        except self.processes.NoSuchProcess:
            return False
        # Access-denied or unavailable process evidence must never be treated as exit.

    def track(self, pid: int):
        if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0 or pid in {os.getpid(), self.parent_pid}:
            raise RuntimeError("invalid managed AEDT process identity")
        created = self.processes.Process(pid).create_time()
        with self.lock:
            self.resources[pid] = created
        self.report_resource(pid, created)
        if self.job is not None: self.job.include_process(pid, created)

    def cleanup(self) -> bool:
        with self.lock:
            snapshots = list(self.resources.items())
        confirmed = True
        for pid, created in snapshots:
            try:
                if not self.alive(pid, created):
                    with self.lock: self.resources.pop(pid, None)
                    continue
                process = self.processes.Process(pid)
                # Take child identities before terminating the root; recheck each identity.
                children = [(child.pid, child.create_time()) for child in process.children(recursive=True)]
                targets = children[::-1] + [(pid, created)]
                for child_pid, child_created in targets:
                    if self.alive(child_pid, child_created): self.processes.Process(child_pid).kill()
                for child_pid, child_created in targets:
                    if self.alive(child_pid, child_created):
                        try: self.processes.Process(child_pid).wait(timeout=2)
                        except self.processes.TimeoutExpired: pass
                    if self.alive(child_pid, child_created): confirmed = False
                if not self.alive(pid, created):
                    with self.lock: self.resources.pop(pid, None)
            except self.processes.NoSuchProcess:
                with self.lock: self.resources.pop(pid, None)
            except Exception:
                confirmed = False
        return confirmed

    def start(self, stream):
        def watch_parent():
            while not self.finished.wait(0.1):
                try: parent_alive = self.alive(self.parent_pid, self.parent_created)
                except Exception: parent_alive = False
                if not parent_alive: self.cancelled.set()
                if self.cancelled.is_set() and self.cleanup(): self.exit_process(75)

        def watch_control():
            try:
                for line in stream:
                    try:
                        if json.loads(line).get("event") == "cancel": self.cancelled.set(); return
                    except (ValueError, AttributeError): continue
                if not self.finished.is_set(): self.cancelled.set()
            except Exception:
                self.cancelled.set()

        threading.Thread(target=watch_parent, name="thermal-parent-watch", daemon=True).start()
        threading.Thread(target=watch_control, name="thermal-cancel-watch", daemon=True).start()

    def finish(self):
        # Release is checked by the operation too. This guard reaps only its own tracked sessions.
        while not self.cleanup(): time.sleep(0.1)
        self.finished.set()


def start_managed(parent_pid: int, report_resource, stream):
    global _CURRENT
    lifecycle = ManagedLifecycle(parent_pid, report_resource)
    _CURRENT = lifecycle
    lifecycle.start(stream)
    return lifecycle


def track_session(app: Any):
    if _CURRENT is None:
        return
    desktop = getattr(app, "desktop_class", None)
    pid = getattr(desktop, "aedt_process_id", None)
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        raise RuntimeError("AEDT session did not provide a managed process identity")
    _CURRENT.track(pid)


def finish_managed(lifecycle):
    global _CURRENT
    try: lifecycle.finish()
    finally: _CURRENT = None


def read_managed_request(stream):
    """Read without TextIO buffering so a daemon control reader holds no interpreter IO lock."""
    descriptor = stream.fileno()
    buffered = bytearray()
    while b"\n" not in buffered:
        chunk = os.read(descriptor, 16384)
        if not chunk: return "", iter(())
        buffered.extend(chunk)
        if len(buffered) > 64 * 1024 * 1024: raise ValueError('managed request exceeds 64 MiB')
    request, remainder = buffered.split(b"\n", 1)
    def controls():
        pending = remainder
        while True:
            if b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                yield line.decode('utf-8')
                continue
            chunk = os.read(descriptor, 4096)
            if not chunk: return
            pending += chunk
    return request.decode('utf-8'), controls()

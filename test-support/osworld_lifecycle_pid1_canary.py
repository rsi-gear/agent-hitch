"""Run as PID 1 in a disposable, network-disabled Linux test container."""
import os
from pathlib import Path

from osworld_lifecycle_smoke import LifecycleTests
from runtime_config import read_json
from vm_owner import VMOwner

assert os.getpid() == 1, 'requires a dedicated test container, without --init'
case = LifecycleTests()
case.setUp()
try:
    runtime, server = case.start('daemon-helper')
    assert case.call(server, 'prepare')['status'] == 'ok'
    helper = int((runtime.private / 'daemon.pid').read_text())
    assert Path(f'/proc/{helper}').is_dir()
    assert int(Path(f'/proc/{helper}/stat').read_text().rsplit(') ', 1)[1].split()[1]) == 1
    case.submit(runtime)
    assert case.call(server, 'quiesce')['status'] == 'ok'
    assert runtime.worker.returncode == 0
    assert not Path(f'/proc/{helper}').exists()
    assert not VMOwner().children()
    assert case.call(server, 'snapshot')['status'] == 'ok'
    assert any(f['path'] == 'worker-exit.json' for f in read_json(runtime.evidence / 'snapshot.json')['files'])
    assert case.call(server, 'cleanup')['status'] == 'ok'
    assert len(case.closed_sessions) == 1
finally:
    case.tearDown()
print('Linux PID1 lifecycle reaped SDK and daemonized helper before evidence snapshot (synthetic only)')

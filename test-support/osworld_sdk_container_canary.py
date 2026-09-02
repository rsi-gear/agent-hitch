"""Pinned installed SDK + declared deadline adapter; synthetic task/guest, no model.

Run on the host with --image <built immutable controller image>. The private
guest endpoint is a test process in a network-disabled disposable container,
not an OSWorld VM or a validation of official benchmark data.
"""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import zlib


def guest():
    stop, operations = threading.Event(), []
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', 1920, 1080, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress((b'\x00' + b'\x11\x22\x33' * 1920) * 1080)) + chunk(b'IEND', b'')
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def reply(self, value, kind='application/json'):
            data = value if isinstance(value, bytes) else json.dumps(value).encode()
            self.send_response(200); self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
        def do_GET(self):
            operations.append('GET ' + self.path)
            if self.path == '/screenshot': self.reply(png, 'image/png')
            elif self.path == '/terminal': self.reply({'output': 'synthetic readiness'})
            else: self.send_error(404)
        def do_POST(self):
            operations.append('POST ' + self.path)
            if self.path == '/control':
                session = json.loads(Path('/control/session.json').read_text())
                request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                assert self.headers['Authorization'] == 'Bearer ' + session['token']
                assert all(request[k] == session[k] for k in ['lease_id', 'epoch'])
                if request['operation'] == 'close':
                    self.reply({'closed': True}); stop.set()
                else:
                    assert request['operation'] in ['start', 'reset']
                    self.reply({'ready': True})
            elif self.path == '/start_recording': self.reply({'recording': True})
            elif self.path == '/end_recording': self.reply(b'synthetic recording bytes', 'video/mp4')
            else: self.send_error(404)
    servers = [ThreadingHTTPServer(('127.0.0.1', port), Handler) for port in [5000, 8770]]
    threads = [threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.02}, daemon=True) for server in servers]
    for thread in threads: thread.start()
    Path('/private/mock-guest-ready').touch()
    stop.wait()
    for server in servers: server.shutdown(); server.server_close()
    for thread in threads: thread.join(2)
    Path('/private/mock-guest-closed.json').write_text(json.dumps({'closed': True, 'operations': operations}))


TASK = '''from desktop_env.task_base import BaseTask
from desktop_env.file_source import asset

class SyntheticTask(BaseTask):
    id = "synthetic-installed-sdk"
    instruction = "Complete this synthetic SDK integration task."
    def setup(self, setup_controller, use_proxy=False):
        assert asset("marker.txt") == "/assets/marker.txt"
    def evaluate(self, env):
        assert env.action_history == ["DONE"]
        return {"score": 0.25, "synthetic_only": True, "local_asset_base_checked": True}
'''


def run(image, output):
    def docker(*args, input=None, timeout=30):
        result = subprocess.run(['docker', *args], input=input, text=True, capture_output=True, timeout=timeout)
        if result.returncode:
            # Never echo arbitrary controller stdout/stderr or phase bindings.
            raise RuntimeError('Docker canary operation failed: ' + args[0])
        return result.stdout
    identity = json.loads(docker('image', 'inspect', image))[0]
    assert identity['Architecture'] == 'amd64' and identity['Os'] == 'linux'
    name = 'hitch-osworld-sdk-canary-' + uuid.uuid4().hex[:12]
    image_id = identity['Id']
    created = False
    with tempfile.TemporaryDirectory(prefix='osw-sdk-') as temporary:
        root = Path(temporary)
        for directory in ['config', 'tasks', 'assets']: (root / directory).mkdir()
        (root / 'tasks/task_999.py').write_text(TASK)
        (root / 'assets/marker.txt').write_text('synthetic asset\n')
        config = {'protocol': 'osworld-controller@1', 'task_id': 'synthetic-installed-sdk', 'source_task_id': 'task_999',
            'profile_digest': 'sha256:' + 'c' * 64, 'sdk_root': '/opt/osworld-sdk', 'sdk_commit': 'd578d2d4e0dc82b43e270fdaa7fa89d9708cd154',
            'task_path': '/tasks/task_999.py', 'task_sha256': 'sha256:' + hashlib.sha256(TASK.encode()).hexdigest(),
            'assets_directory': '/assets', 'private_root': '/private/runtime', 'session_directory': '/control',
            'evidence_directory': '/outputs/evidence', 'cache_directory': '/scratch/cache', 'max_steps': 1,
            'max_actions_per_turn': 2, 'max_text_bytes': 16384, 'max_artifact_bytes': 1048576,
            'prepare_timeout_sec': 120, 'shutdown_timeout_sec': 10, 'sleep_after_execution': 0,
            'native_deadline': True, 'public_endpoint': 'http://controller:8765/', 'website_host_suffix': 'websites.private', 'client_password_file': None}
        (root / 'config/controller.json').write_text(json.dumps(config) + '\n')
        args = ['run', '-d', '--name', name, '--label', 'io.hitch.canary=osworld-sdk', '--platform', 'linux/amd64',
            '--network', 'none', '--add-host', 'vm:127.0.0.1', '--add-host', 'controller:127.0.0.1', '--memory', '1g', '--cpus', '1',
            '--pids-limit', '64', '--read-only']
        for target in ['/tmp', '/private', '/control', '/outputs', '/scratch', '/run/osworld']:
            args += ['--tmpfs', target + ':rw,nosuid,nodev,size=32m']
        for directory in ['config', 'tasks', 'assets']:
            args += ['--mount', f'type=bind,src={root / directory},dst=/{directory},readonly']
        args += ['--mount', f'type=bind,src={Path(__file__).resolve()},dst=/test-canary.py,readonly', image_id]
        try:
            docker(*args); created = True
            docker('exec', '-d', name, 'python', '/test-canary.py', '--guest')
            ready = "import pathlib,time; end=time.monotonic()+25\nwhile time.monotonic()<end:\n if pathlib.Path('/private/runtime/lifecycle.sock').exists() and pathlib.Path('/private/mock-guest-ready').exists(): break\n time.sleep(0.05)\nelse: raise SystemExit(1)"
            docker('exec', name, 'python', '-c', ready)
            def lifecycle(phase):
                request = {'schema_version': '1', 'request_id': 'sdk_canary_' + phase, 'phase': phase, 'task_id': config['task_id'],
                    'logical_trial_id': name, 'execution_index': 0, 'lease_id': 'lease_' + name, 'epoch': 1, 'profile_digest': config['profile_digest'], 'input_refs': []}
                response = json.loads(docker('exec', '-i', name, 'python', '/opt/osworld/lifecycle_client.py', '--socket', '/private/runtime/lifecycle.sock', '--timeout-sec', '140', input=json.dumps(request), timeout=145))
                assert response['status'] == 'ok', response
                return response['output']
            prepared = lifecycle('prepare')
            assert prepared == {'ready': True, 'native_phases_ready': True, 'native_deadline_ready': True}
            print('Installed SDK produced its first native observation after the unchanged setup wait.', flush=True)
            bind = {'request_id': 'canary_bind', 'operation': 'bind', 'parameters': {'generation': 1, 'run_id': 'run_' + 'e' * 32}}
            binding = json.loads(docker('exec', '-i', name, 'python', '/opt/osworld/controller_client.py', '--socket', '/private/runtime/phase.sock', '--session', '/control/session.json', input=json.dumps(bind)))['binding']
            submit = "import json,sys,urllib.request; b=json.load(sys.stdin); p={'name':'desktop.submit','arguments':{'sequence':1,'request_id':'canary_done','response':'','actions':['DONE']}}; r=urllib.request.Request(b['endpoint']+'call',data=json.dumps(p).encode(),headers={'Authorization':'Bearer '+b['token'],'Content-Type':'application/json'}); print(urllib.request.urlopen(r,timeout=10).read().decode())"
            accepted = json.loads(docker('exec', '-i', name, 'python', '-c', submit, input=json.dumps(binding)))
            assert accepted['accepted'] is True
            assert lifecycle('quiesce') == {'quiesced': True}
            snapshot = lifecycle('snapshot')
            assert lifecycle('cleanup') == {'cleaned': True}
            def read(file): return json.loads(docker('exec', name, 'python', '-c', 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).read_text())', file))
            result = read('/outputs/evidence/native/result.json')
            assert result == {'score': 0.25, 'synthetic_only': True, 'local_asset_base_checked': True}
            execution = read('/outputs/evidence/native-execution.json')
            assert execution['native']['scores'] == [0.25]
            assert execution['native']['deadline_adapter']['protocol'] == 'osworld-native-deadline@1'
            frozen = read('/outputs/evidence/snapshot.json')
            assert any(f['path'] == 'native/recording.mp4' for f in frozen['files'])
            stopped = read('/private/mock-guest-closed.json')
            assert stopped['closed'] and stopped['operations'].count('POST /control') == 2
            assert '/accessibility' not in json.dumps(stopped) and 'POST /execute' not in stopped['operations']
            summary = read('/outputs/evidence/native/summary/results.json')
            assert len(summary) == 1 and summary[0]['task_id'] == 'synthetic-installed-sdk' and summary[0]['score'] == 0.25
            receipt = {'protocol': 'osworld-installed-sdk-canary@1', 'synthetic_only': True, 'model_used': False, 'official_vm_used': False,
                'image_id': image_id, 'task_file_sha256': config['task_sha256'], 'real_scored_tasks': 0,
                'prepare': prepared, 'snapshot': snapshot, 'native_result': result, 'native_execution': execution, 'native_summary': summary,
                'mock_guest_operations': stopped['operations'], 'image_source_manifest': read('/opt/osworld-source-manifest.json')['git_archive_sha256']}
            output = Path(output)
            with output.open('x') as file: json.dump(receipt, file, indent=2); file.write('\n')
            print(json.dumps({'installed_sdk_worker_canary': 'passed', 'synthetic_only': True, 'image_id': image_id, 'receipt': str(output)}), flush=True)
        except BaseException:
            if created:
                diagnostics = "import json,pathlib; root=pathlib.Path('/private/runtime'); out={};\nfor n in ['worker-status.json','lifecycle.json']:\n p=root/n\n if p.exists(): out[n]=json.loads(p.read_text())\nprint(json.dumps(out))"
                try:
                    data = json.loads(docker('exec', name, 'python', '-c', diagnostics))
                    Path(str(output) + '.failed.json').write_text(json.dumps(data, indent=2) + '\n')
                except Exception: pass
            raise
        finally:
            if created: docker('rm', '-f', name)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--guest', action='store_true')
    parser.add_argument('--image')
    parser.add_argument('--output')
    args = parser.parse_args()
    if args.guest: guest()
    else:
        if not args.image or not args.output: parser.error('--image and --output are required')
        run(args.image, args.output)

#!/usr/bin/env python3
"""Assemble the two locked, authorized OSWorld samples as a standard package.

No downloads, model calls or Docker launches. Local image config IDs are allowed
only in the explicitly host-local profile; registry digests make it portable.
The resulting package still needs VM/website/model preflight and real trials.
"""
import argparse
import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
SDK = 'd578d2d4e0dc82b43e270fdaa7fa89d9708cd154'
WEB = '90ec2218f7747b15fe5117cdbe59b8978446ab9c'
WEB_APP = '9c50b43bb7c1b03deba31eef234ed805f8014603'
ASSETS = 'acad110ef3136405f95434b54862bf9066176c2a'
HASH_MANIFEST = '42f8f6f8939b8712997d5891456a575f8a2a5f53465e9e3e6747af5d6efd0915'
SAMPLE = ['task_031', 'task_095']
TASK_HASHES = {'task_031': '883db214a66bcf00016e3c25a1111c626afc4aca8586868c45faa392164b0ce1',
               'task_095': '58413e35891268ac0a13098e580a9bc018d0bb61f5737277dce538e7fd36de3d'}
NODE = 'node:22-bookworm@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d'
PYTHON = 'python:3.13.7-slim-bookworm@sha256:adafcc17694d715c905b4c7bebd96907a1fd5cf183395f0ebc4d3428bd22d92d'
CAPS = ['shell', 'artifact-export', 'separate-verifier', 'compose', 'tool-server@1', 'http-json-cli',
        'hitch-hook@1', 'native-image-input', 'tool-result-images@1', 'native-phases@1']


def sha(data): return 'sha256:' + hashlib.sha256(data).hexdigest()


def write(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n' if not isinstance(value, str) else value)


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    loaded = importlib.util.module_from_spec(spec); spec.loader.exec_module(loaded)
    return loaded


def clean_git(root, commit):
    command = ['git', '-C', str(root)]
    if (subprocess.check_output([*command, 'rev-parse', 'HEAD'], text=True).strip() != commit
            or subprocess.check_output([*command, 'status', '--porcelain'], text=True).strip()):
        raise ValueError('source checkout differs from its locked clean revision')


def verified_file(root, name, expected, size=None):
    if not isinstance(name, str) or not name or '\\' in name or any(p in ('', '.', '..') for p in name.split('/')):
        raise ValueError('unsafe source path')
    file = Path(root)
    for part in name.split('/'):
        file = file / part
        if file.is_symlink(): raise ValueError('linked source is forbidden')
    data = file.read_bytes()
    if sha(data) != 'sha256:' + expected.removeprefix('sha256:') or size is not None and len(data) != size:
        raise ValueError('source bytes differ from locked identity')
    return data


def assemble(args):
    if not 1 <= args.max_steps <= 100000 or not 60 <= args.agent_timeout_sec <= 86400:
        raise ValueError('explicit candidate budgets are outside supported bounds')
    transport = module('osworld_screenshot_transport', HERE / 'runtime/screenshot_transport.py').transport_profile(args.screenshot_http_timeout_sec)
    for root, commit in [(args.sdk_root, SDK), (args.web_root, WEB), (Path(args.web_root) / 'teamchat_web', WEB_APP)]:
        clean_git(root, commit)
    hashes_raw = Path(args.task_hash_manifest).read_bytes()
    if sha(hashes_raw) != 'sha256:' + HASH_MANIFEST: raise ValueError('release task hash manifest mismatch')
    hashes = json.loads(hashes_raw)['files']
    population = sorted(name.removesuffix('.py') for name in hashes if re.fullmatch(r'task_[0-9]{3}\.py', name))
    chosen = sorted(population, key=lambda name: hashlib.sha256(('20260902\0' + name).encode()).hexdigest())[:2]
    if len(population) != 108 or chosen != SAMPLE: raise ValueError('fixed sample membership changed')
    images = json.loads(Path(args.images).read_bytes())
    keys = {'controller', 'vm', 'teamchat_backend', 'teamchat_frontend', 'proxy'}
    if set(images) != {'protocol', 'scope', 'images', 'vm_acceleration', 'vm_cpu_model'} or images['protocol'] != 'osworld-deployment-images@1' or set(images['images']) != keys:
        raise ValueError('invalid deployment image contract')
    local = images['scope'] == 'host-local'
    if images['scope'] not in ('host-local', 'portable') or images['vm_acceleration'] not in ('tcg', 'kvm'):
        raise ValueError('explicit image portability and acceleration are required')
    if args.screenshot_http_timeout_sec != 10 and images['vm_acceleration'] != 'tcg':
        raise ValueError('extended screenshot HTTP waits require an explicit TCG profile')
    for name, value in images['images'].items():
        if set(value) != {'reference', 'platform'} or value['platform'] not in ('linux/amd64', 'linux/arm64'):
            raise ValueError('invalid service image identity')
        reference = value['reference']
        if not isinstance(reference, str) or not (re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._/:-]*@sha256:[a-f0-9]{64}', reference)
                or local and re.fullmatch(r'sha256:[a-f0-9]{64}', reference)):
            raise ValueError('service image must be immutable')
        if name != 'vm' and value['platform'] != 'linux/amd64': raise ValueError('non-VM service architecture is not validated')
    if images['images']['vm']['platform'] == 'linux/arm64' and images['vm_acceleration'] != 'tcg':
        raise ValueError('ARM host x86 guest requires explicit TCG')
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', str(images['vm_cpu_model'])):
        raise ValueError('explicit QEMU CPU model is required')
    asset_records = {}
    for receipt in args.asset_receipts:
        for item in json.loads(Path(receipt).read_bytes())['files']:
            if item['revision'] != ASSETS or item['repository'] != 'xlangai/osworld_v2_assets_gated' or item.get('upstream_blob_verified') is not True:
                raise ValueError('asset acquisition is not the verified release')
            previous = asset_records.setdefault(item['file'], item)
            if previous['sha256'] != item['sha256'] or previous['size'] != item['size']: raise ValueError('conflicting asset receipts')
    model_profile = json.loads((HERE / 'deepseek-profile.json').read_bytes())
    profile = {'schema_version': '1', 'id': 'osworld-v2-deepseek-graphical-' + ('host-local' if local else 'portable') + (f'-tcg-http-{args.screenshot_http_timeout_sec}s' if args.screenshot_http_timeout_sec != 10 else ''),
        'track': 'custom', 'input_mode': 'instruction',
        'tool_policy': {'id': 'osworld-graphical-computer13', 'allowed': CAPS, 'network': 'open', 'enforcement': 'required'},
        'budget': {'agent_timeout': {'source': 'task'}, 'setup_timeout_ms': 1800000, 'collection_timeout_ms': 1800000, 'cleanup_grace_ms': 600000},
        'sampling': {'attempts_per_task': 1, 'seed': 20260902},
        'grading': {'on_agent_budget_exhausted': 'grade_final_state', 'on_missing_submission': 'error', 'infrastructure_retries': 0},
        'extensions': {'max_steps': args.max_steps, 'agent_timeout_sec': args.agent_timeout_sec, 'images': images,
            'model_profile': model_profile, 'sdk_commit': SDK, 'metric_semantics': 'native scalar; no derived strict success',
            'screen_size': [1920, 1080], 'screenshot_transport': transport,
            'candidate_guide_sha256': sha((HERE / 'candidate-guide.md').read_bytes()),
            'task_current_date': 'unchanged native SDK', 'leaderboard_comparable': False}}
    profile_digest = sha(json.dumps(profile, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode())
    output = Path(args.out).absolute()
    if output.exists() or output.is_symlink(): raise ValueError('assembly requires fresh output')
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='.osworld-package-', dir=output.parent))
    try:
        (staging / 'adapter').mkdir()
        for name in ('assemble.py', 'prepare-state-assets.py', 'web_routes.py', 'deepseek-profile.json', 'candidate-guide.md'):
            shutil.copyfile(HERE / name, staging / 'adapter' / name)
        runtime = staging / 'runtime'; runtime.mkdir()
        for file in (HERE / 'runtime').glob('*.py'): shutil.copyfile(file, runtime / file.name)
        # Import only the pinned public action definitions, never task classes.
        action_file = Path(args.sdk_root) / 'desktop_env/actions.py'
        policy_module = module('hitch_osworld_actions', HERE / 'runtime/action_policy.py')
        if sha(action_file.read_bytes()) != 'sha256:' + policy_module.ACTIONS_SHA256: raise ValueError('action definitions changed')
        policy = policy_module.GraphicalActionPolicy(module('osworld_public_actions', action_file).ACTION_SPACE)
        write(runtime / 'tools.json', policy.tool_definitions(max_actions_per_turn=32, max_text_bytes=65536))
        write(staging / 'profiles/default.json', profile)
        write(staging / 'benchmark.toml', '''schema_version = "1"
protocol = "hitch-benchmark@1"
id = "osworld-v2"
release = "osworld-v2-2026.08.08"
task_root = "tasks"
task_ids = ["osworld-task-031", "osworld-task-095"]
default_profile = "profiles/default.json"
primary_metric = "native_score"
runtime_components = [{id = "osworld", protocol = "tool-server@1", path = "runtime"}]
[task_format]
name = "harbor"
schema_version = "1.4"
[source]
kind = "local"
path = "."
access = "gated"
license = "Upstream gated dataset terms; do not redistribute task bodies or assets"
[metrics.native_score]
type = "scalar"
direction = "maximize"
range = [0, 1]
reducer = "task_macro_mean"
[publication]
track = "custom"
training_eligible = false
''')
        transforms = []
        for source in SAMPLE:
            task_id = 'osworld-' + source.replace('_', '-')
            task = staging / 'tasks' / task_id; environment = task / 'environment'; tests = task / 'tests'
            environment.mkdir(parents=True); tests.mkdir()
            record = hashes[source + '.py']
            data = verified_file(args.tasks_root, source + '.py', TASK_HASHES[source], record['size'])
            write(environment / 'tasks' / (source + '.py'), data.decode())
            assets = environment / 'assets'; assets.mkdir()
            # These two pinned task modules use only literal asset() arguments.
            referenced = set()
            for call in ast.walk(ast.parse(data)):
                if isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id == 'asset':
                    if len(call.args) != 1 or call.keywords: raise ValueError('dynamic task asset reference')
                    referenced.add(ast.literal_eval(call.args[0]))
            for name in sorted(referenced):
                item = asset_records[name]
                blob = verified_file(args.assets_root, name, item['sha256'], item['size'])
                target = assets / name; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(blob)
            if source == 'task_031':
                original = assets / 'task_031/state.json'
                shutil.copyfile(original, environment / 'state.original.json')
                receipt = environment / 'asset-acquisition.json'
                write(receipt, {'files': [{k: v for k, v in item.items() if k != 'local_path'} for item in asset_records.values()]})
                mirror = environment / 'state-mirror'
                module('osworld_state_assets', HERE / 'prepare-state-assets.py').prepare(original, sha(original.read_bytes()), args.assets_root,
                    receipt, 'http://assets.trial.hitch.test', mirror)
                shutil.copyfile(mirror / 'private/state.json', original)
                transforms.append({'kind': 'osworld-state-asset-rebase@1', 'before_path': str((environment / 'state.original.json').relative_to(staging)),
                                   'after_path': str(original.relative_to(staging))})
            config = {'protocol': 'osworld-controller@1', 'task_id': task_id, 'source_task_id': source, 'profile_digest': profile_digest,
                'sdk_root': '/opt/osworld-sdk', 'sdk_commit': SDK, 'task_path': '/tasks/' + source + '.py', 'task_sha256': 'sha256:' + TASK_HASHES[source],
                'assets_directory': '/assets', 'private_root': '/private/runtime', 'session_directory': '/control',
                'evidence_directory': '/evidence', 'cache_directory': '/cache', 'max_steps': args.max_steps,
                'max_actions_per_turn': 32, 'max_text_bytes': 65536, 'max_artifact_bytes': 2 * 1024**3,
                'prepare_timeout_sec': 1500, 'shutdown_timeout_sec': 300, 'sleep_after_execution': 2,
                'screenshot_http_timeout_sec': args.screenshot_http_timeout_sec,
                'native_deadline': True, 'public_endpoint': 'http://controller:8765/', 'website_host_suffix': 'trial.hitch.test', 'client_password_file': None}
            write(environment / 'controller.json', config); shutil.copyfile(environment / 'controller.json', tests / 'controller.json')
            shutil.copyfile(HERE / 'candidate-guide.md', task / 'instruction.md')
            phases = {'protocol': 'hitch-native-phase-control@2', 'argv': ['/opt/venv/bin/python', '/opt/osworld/controller_client.py', '--socket', '/private/runtime/phase.sock', '--session', '/control/session.json'],
                      'audit_path': '/evidence/channel/channel.jsonl', 'shutdown_timeout_ms': 300000, 'finalization_timeout_ms': 1800000}
            write(task / 'task.hitch.json', {'schema_version': '1', 'source_task_id': source,
                'driver': {'kind': 'tool-server', 'protocol_version': '1', 'config': {'transport': 'http-json-cli', 'endpoint': 'http://controller:8765/', 'schema': 'runtime/tools.json', 'service': 'controller', 'native_phases': phases}},
                'requirements': CAPS, 'lifecycle': {phase: {'protocol': 'hitch-hook@1', 'target': 'environment:controller',
                    'argv': ['/opt/venv/bin/python', '/opt/osworld/lifecycle_client.py', '--socket', '/private/runtime/lifecycle.sock', '--timeout-sec', str(seconds)],
                    'timeout_ms': (seconds + 10) * 1000} for phase, seconds in [('prepare', 1600), ('quiesce', 1700), ('snapshot', 300), ('cleanup', 500)]},
                'submission': {'kind': 'artifacts', 'paths': ['/evidence'], 'max_bytes': config['max_artifact_bytes']},
                'grading': {'kind': 'command', 'entrypoint': ['bash', '/tests/test.sh'], 'metric_map': {'native_score': 'native_score'}}})
            write(task / 'task.toml', f'''schema_version = "1.4"
artifacts = [{{source = "/evidence", service = "controller"}}]
[agent]
timeout_sec = {args.agent_timeout_sec}
[environment]
build_timeout_sec = 1800
cpus = 1
memory_mb = 1024
workdir = "/app"
network_mode = "public"
[verifier]
timeout_sec = 300
environment_mode = "separate"
[verifier.environment]
cpus = 1
memory_mb = 512
network_mode = "public"
''')
            write(environment / 'Dockerfile', f'FROM {NODE}\nWORKDIR /app\nCMD ["sleep", "infinity"]\n')
            write(tests / 'Dockerfile', f'FROM {PYTHON}\nCOPY grade.py controller.json test.sh /tests/\nCMD ["sleep", "infinity"]\n')
            shutil.copyfile(HERE / 'runtime/grade.py', tests / 'grade.py')
            write(tests / 'test.sh', '#!/bin/bash\nset -euo pipefail\npython /tests/grade.py\n')
            def service(image, cpu, memory, **extra):
                value = images['images'][image]
                return {'image': value['reference'], 'platform': value['platform'], 'cpus': cpu, 'mem_limit': memory, 'pids_limit': 256, **extra}
            services = {'main': {'platform': 'linux/amd64', 'build': {'context': '.', 'dockerfile': 'Dockerfile'},
                'command': ['sleep', 'infinity'], 'networks': ['tools'], 'depends_on': {'controller': {'condition': 'service_healthy'}}},
                'controller': service('controller', 1, '1024m', networks=['tools', 'vm'],
                    environment={**model_profile['environment'], 'DEEPSEEK_API_KEY': '${DEEPSEEK_API_KEY:?Configure the authorized DeepSeek key in the host process}'},
                    volumes=['./controller.json:/config/controller.json:ro', './tasks:/tasks:ro', './assets:/assets:ro', 'control:/control', 'private:/private', 'evidence:/evidence', 'cache:/cache'],
                    tmpfs=['/tmp:size=256m', '/run/osworld:size=16m'], read_only=True,
                    healthcheck={'test': ['CMD', '/opt/venv/bin/python', '-c', 'from pathlib import Path; assert Path("/private/runtime/lifecycle.sock").is_socket()'], 'interval': '1s', 'timeout': '2s', 'retries': 60},
                    depends_on={'vm': {'condition': 'service_healthy'}}),
                'vm': service('vm', 4, '5g', networks=['vm', 'egress'], volumes=['control:/control:ro', 'vm_storage:/storage'],
                    environment={'KVM': 'Y' if images['vm_acceleration'] == 'kvm' else 'N', 'CPU_MODEL': images['vm_cpu_model'], 'CPU_CORES': '4', 'RAM_SIZE': '4G', 'VM_BOOT_TIMEOUT_SEC': '300'},
                    healthcheck={'test': ['CMD', '/usr/bin/python3', '-c', 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8770/health", timeout=1)'], 'interval': '1s', 'timeout': '2s', 'retries': 30})}
            if images['vm_acceleration'] == 'kvm': services['vm']['devices'] = ['/dev/kvm:/dev/kvm']
            volumes = {name: {} for name in ['control', 'private', 'evidence', 'cache', 'vm_storage']}
            networks = {'tools': {}, 'vm': {'internal': True}, 'egress': {}}
            if source == 'task_031':
                shutil.copyfile(Path(args.web_root) / 'teamchat_web/STATE.md', environment / 'STATE.md')
                router = module('osworld_web_routes', HERE / 'web_routes.py')
                # Match the pinned labels exactly; no host Docker socket.
                labels = {'caddy': '${CADDY_SCHEME-http://}teamchat.${HOST_SUFFIX:-localhost}', 'caddy.0_reverse_proxy': '/api* teamchat_web_backend:8000',
                          'caddy.1_reverse_proxy': '/mcp* teamchat_web_backend:8000', 'caddy.2_reverse_proxy': 'teamchat_web_frontend:80'}
                plan, caddy = router.compile_routes({'teamchat_web': {'services': {'teamchat_web_backend': {}, 'teamchat_web_frontend': {'labels': labels}}}}, 'trial.hitch.test')
                write(environment / 'Caddyfile', caddy); write(environment / 'routes.json', plan)
                services.update({'teamchat_web_backend': service('teamchat_backend', 0.5, '256m', networks=['web'], environment={'API_PREFIX': '/api', 'ENV': 'production'}, volumes=['./STATE.md:/app/STATE.md:ro']),
                    'teamchat_web_frontend': service('teamchat_frontend', 0.25, '128m', networks=['web']),
                    'web_proxy': service('proxy', 0.25, '128m', networks={'web': None, 'vm': {'aliases': plan['router_dns_aliases']}},
                        entrypoint=['/bin/caddy'], command=['run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
                        volumes=['./Caddyfile:/etc/caddy/Caddyfile:ro', 'web_proxy_data:/data', 'web_proxy_config:/config']),
                    'assets': {'image': PYTHON, 'platform': 'linux/amd64', 'cpus': 0.25, 'mem_limit': '128m', 'pids_limit': 64,
                        'command': ['python', '-m', 'http.server', '80', '--directory', '/public'], 'read_only': True,
                        'volumes': ['./state-mirror/public:/public:ro'], 'networks': {'vm': {'aliases': ['assets.trial.hitch.test']}}}})
                volumes.update(web_proxy_data={}, web_proxy_config={}); networks['web'] = {'internal': True}
            write(environment / 'docker-compose.yaml', {'services': services, 'volumes': volumes, 'networks': networks})
        write(staging / 'source-manifest.json', {'status': 'assembled_execution_pending', 'sdk_commit': SDK, 'web_commit': WEB, 'web_app_commit': WEB_APP,
            'task_hash_manifest_sha256': 'sha256:' + HASH_MANIFEST, 'asset_revision': ASSETS, 'images': images,
            'adapter': {'id': 'osworld-fixed-samples', 'version': '1', 'path': 'adapter/assemble.py'},
            'selection': {'algorithm': 'sha256-rank-v1', 'seed': 20260902, 'population_size': 108, 'tasks': SAMPLE, 'resample_on_failure': False},
            'tasks': [{'task_id': 'osworld-' + name.replace('_', '-'), 'source_task_id': name, 'source_sha256': 'sha256:' + TASK_HASHES[name]} for name in SAMPLE],
            'transformations': transforms, 'real_scored_tasks': 0,
            'pending_validation': ['VM graphical readiness and namespace routing', 'full Hitch lifecycle and offline scorer', 'two fixed real candidate trials']})
        staging.rename(output)
    finally:
        if staging.exists(): shutil.rmtree(staging)
    return {'package': str(output), 'profile_digest': profile_digest, 'tasks': SAMPLE, 'real_scored_tasks': 0}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('sdk-root', 'web-root', 'tasks-root', 'task-hash-manifest', 'assets-root', 'images', 'out'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--asset-receipts', required=True, nargs='+')
    parser.add_argument('--max-steps', required=True, type=int)
    parser.add_argument('--agent-timeout-sec', required=True, type=int)
    parser.add_argument('--screenshot-http-timeout-sec', default=10, type=int,
                        help='Explicit TCG screenshot transport override (10..120); default keeps native SDK behavior')
    print(json.dumps(assemble(parser.parse_args()), indent=2))

"""Host-only generic adapter for pinned isolated capability services.

The Agent supplies action requests, not effective permissions or execution
results. Durable reservations live in the existing host parameter authority.
"""
from __future__ import annotations
import asyncio
import base64
import hashlib
import json
import math
from pathlib import Path
import re
import shlex
import tempfile
import time

MAX_BYTES = 16 * 1024 * 1024

class CapabilitySession:
    def __init__(self, owner):
        self.owner, self.env = owner, owner.env
        self.deadline = None
        self.active_binding = None

    async def prepare(self):
        bindings = self.owner.state.get('bindings', [])
        if not bindings:
            return
        seconds = min(b['max_action_seconds'] for b in bindings)
        explicit = getattr(self.owner.agent, 'hitch_timeout_ms', 0)
        if explicit > 0:
            seconds = min(seconds, explicit / 1000)
        deadline_ms = min(self.owner.state.get("capability_deadline_ms", float("inf")), int((time.time() + seconds) * 1000))
        self.deadline = time.monotonic() + deadline_ms / 1000 - time.time()
        if self.deadline <= time.monotonic():
            raise RuntimeError("unsupported_constraint: capability whole-task wall budget exhausted before resume")
        for binding in bindings:
            # This fixed host probe hashes the installed script itself. The
            # plugin cannot self-attest a substitute source or dependency set.
            code = "import hashlib,importlib.metadata,json,pathlib,platform; print(json.dumps({'source_digest':'sha256:'+hashlib.sha256(pathlib.Path(" + repr(binding['entrypoint']) + ").read_bytes()).hexdigest(),'runtime':{k:(platform.python_version() if k=='python' else importlib.metadata.version(" + repr(binding['dependency_packages']) + "[k])) for k in " + repr(list(binding['dependencies'])) + "}}))"
            probe = await self.env.service_exec('python3 -I -c ' + shlex.quote(code), service=binding['service'], timeout_sec=15)
            if probe.return_code or len(probe.stdout or '') > 65536:
                raise RuntimeError('unsupported_constraint: capability runtime probe failed')
            observed = json.loads(probe.stdout)
            if observed.get('source_digest') != binding['source']['sha256']:
                raise RuntimeError('unsupported_constraint: capability runtime source changed')
            for name, expected in binding['dependencies'].items():
                actual = observed.get('runtime', {}).get(name)
                if not isinstance(actual, str) or (actual != expected and not (name == 'python' and actual.startswith(expected + '.'))):
                    raise RuntimeError('unsupported_constraint: capability dependency version differs: ' + name)
            runtime_observed = observed
            # Observe Docker's actual isolation and cgroup bounds rather than
            # accepting Compose text as proof that limits were applied.
            selected = await self.env._run_docker_compose_command(['ps', '--all', '--quiet', binding['service']])
            container = (selected.stdout or '').strip()
            if not re.fullmatch(r'[a-f0-9]{64}', container):
                raise RuntimeError('unsupported_constraint: capability container identity unavailable')
            child = await asyncio.create_subprocess_exec('docker', 'inspect', container, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
            try:
                out, _ = await asyncio.wait_for(child.communicate(), 15)
            except BaseException:
                child.kill(); await child.wait(); raise
            if child.returncode or len(out) > 1024 * 1024:
                raise RuntimeError('unsupported_constraint: capability resource observation unavailable')
            facts = json.loads(out)[0]; host = facts['HostConfig']
            limits = getattr(self.env, '_hitch_service_resource_limits', {}).get(binding['service'])
            if (not limits or host.get('NetworkMode') != 'none' or facts.get('Mounts') or host.get('Privileged')
                or host.get('PidMode') or host.get('NanoCpus') != limits['cpu_millis'] * 1000000 or host.get('Memory') != limits['memory_bytes']):
                raise RuntimeError('unsupported_constraint: capability isolation/resources were not enforced')
            await self.authority('capability-runtime', {'id': binding['id'], 'deadline_ms': deadline_ms, 'observation': {
                'source_digest': runtime_observed['source_digest'], 'runtime': runtime_observed['runtime'],
                'container_id': container, 'image_identity': facts.get('Image'),
                'network_mode': host['NetworkMode'], 'mounts': [], 'privileged': False,
                'cpu_millis': limits['cpu_millis'], 'memory_bytes': limits['memory_bytes']}})
            self.deadline = min(self.deadline, time.monotonic() + self.owner.state.get('capability_deadline_ms', deadline_ms) / 1000 - time.time())

    def remaining(self, binding):
        remaining = min(binding['max_action_seconds'], (self.deadline or 0) - time.monotonic())
        if remaining < 1:
            raise RuntimeError('capability whole-task time budget exhausted')
        return max(1, math.floor(remaining))

    async def invoke(self, binding, request):
        seconds = self.remaining(binding) - 2
        if seconds < 1:
            raise RuntimeError('capability wall budget exhausted before safe shutdown margin')
        data = json.dumps(request, separators=(',', ':'))
        if len(data.encode()) > MAX_BYTES:
            raise RuntimeError('capability request exceeds size limit')
        # timeout lives inside the service so losing the Compose client cannot
        # leave an unbounded action. stop() additionally stops the whole sidecar.
        command = 'printf %s ' + shlex.quote(data) + ' | timeout --signal=TERM --kill-after=2s ' + str(seconds) + 's python3 -I ' + shlex.quote(binding['entrypoint'])
        self.active_binding = binding
        result = await self.env.service_exec(command, service=binding['service'], timeout_sec=seconds + 3)
        self.active_binding = None
        if result.return_code or len(result.stdout or '') > MAX_BYTES:
            raise RuntimeError('capability process failed with exit ' + str(result.return_code) + ': ' + (result.stderr or result.stdout or '')[-4096:])
        return json.loads(result.stdout)

    async def authority(self, command, request):
        response = await self.owner.call(command, request)
        if 'state' in response:
            self.owner.state = response['state']
        if response.get('accepted') is False:
            raise ValueError(response['reason'])
        return response

    async def execute(self, request):
        context = (await self.authority('capability-plan', request))['context']
        request = context['request']
        binding, action_id = context['binding'], request['id']
        existing = context.get('existing')
        try:
            if existing is None:
                planned = await self.invoke(binding, context['input'])
                await self.authority('capability-reserve', {'request': request, 'plan': planned})
            action = self.owner.state['capability_actions'][action_id]
            if action['status'] in ('unavailable', 'failed'):
                return self.public_action(action_id)
            if action['status'] != 'completed':
                if any(step['status'] == 'started' for step in action['steps']):
                    raise RuntimeError('capability started-step evidence unavailable; it cannot be replayed')
                for index in range(len(action['steps'])):
                    action = self.owner.state['capability_actions'][action_id]
                    step = action['steps'][index]
                    if step['status'] in ('completed', 'failed'):
                        continue
                    await self.authority('capability-start', {'id': action_id, 'index': index})
                    result = await self.invoke(binding, {'command': 'execute', 'plan': action['plan'], 'step': step['input'], 'step_index': index})
                    await self.authority('capability-step', {'id': action_id, 'index': index, 'result': result})
                action = self.owner.state['capability_actions'][action_id]
                result = await self.invoke(binding, {'command': 'finalize', 'plan': action['plan'], 'results': [step['result'] for step in action['steps']]})
                await self.authority('capability-finish', {'id': action_id, 'result': result})
            action = self.owner.state['capability_actions'][action_id]
            delivery = action.get('result', {}).get('delivery')
            if action['status'] == 'completed' and delivery:
                relative = delivery['path']
                if not isinstance(relative, str) or not re.fullmatch(r'[a-zA-Z0-9_.-]+(?:/[a-zA-Z0-9_.-]+)*', relative) or '..' in relative.split('/'):
                    raise RuntimeError('capability delivery path invalid')
                content = base64.b64decode(delivery['bytes_base64'], validate=True)
                if len(content) > MAX_BYTES or 'sha256:' + hashlib.sha256(content).hexdigest() != delivery['sha256']:
                    raise RuntimeError('capability delivery digest mismatch')
                target = binding['output_directory'].rstrip('/') + '/' + relative
                parent = str(Path(target).parent)
                created = await self.env.exec('mkdir -p -- ' + shlex.quote(parent))
                if created.return_code:
                    raise RuntimeError('capability delivery directory unavailable')
                with tempfile.TemporaryDirectory(prefix='hitch-delivery-') as directory:
                    file = Path(directory) / 'delivery'; file.write_bytes(content)
                    await self.env.upload_file(file, target)
            return self.public_action(action_id)
        except asyncio.CancelledError:
            if action_id in self.owner.state['capability_actions']:
                await self.authority('capability-unavailable', {'id': action_id, 'reason': 'cancelled with execution evidence unavailable'})
            await self.stop()
            raise
        except Exception as error:
            await self.stop()
            if action_id in self.owner.state['capability_actions']:
                await self.authority('capability-unavailable', {'id': action_id, 'reason': str(error)[:4096]})
            else:
                await self.owner.call("capability-reject", {"reason": str(error)[:4096], "request": request})
                self.owner.state = await self.owner.call("show", {})
            raise

    def public_action(self, action_id):
        action = self.owner.state['capability_actions'][action_id]
        result = action.get('result') or {}
        delivery = result.get('delivery')
        return {'accepted': action['status'] == 'completed', 'action_id': action_id, 'status': action['status'], 'reason': action.get('reason'),
                'summary': result.get('summary'), 'errors': result.get('errors'), 'counter': self.owner.state['counters'][action['binding']],
                'execution_id': self.owner.state['execution_id'], 'coverage': next(b['coverage'] for b in self.owner.state['bindings'] if b['id'] == action['binding']),
                **({'delivery': {k: v for k, v in delivery.items() if k != 'bytes_base64'}} if delivery else {})}

    async def stop(self):
        if self.active_binding:
            await self.env.stop_service(self.active_binding['service'])
            self.active_binding = None


async def restore_capability_evidence(verifier):
    directory = getattr(getattr(getattr(verifier, 'task', None), 'paths', None), 'environment_dir', None)
    if not directory or not (directory.parent / 'parameters.json').is_file():
        return
    contract = json.loads((directory.parent / 'parameters.json').read_text())
    if not contract.get('capability_bindings'):
        return
    # Recreate from host-only evidence after candidate artifacts are collected.
    # A copied Agent receipt can never replace this trusted channel.
    source = Path(verifier.trial_paths.trial_dir) / 'parameter-evidence.json'
    if not source.is_file() or source.is_symlink() or source.stat().st_size > 64 * 1024 * 1024:
        raise RuntimeError('trusted capability evidence unavailable')
    prepared = await verifier.environment.exec('rm -rf -- /hitch-constraints && mkdir -p /hitch-constraints')
    if prepared.return_code:
        raise RuntimeError('trusted capability evidence injection failed')
    await verifier.environment.upload_file(source, '/hitch-constraints/parameter-evidence.json')

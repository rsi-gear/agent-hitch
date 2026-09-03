#!/usr/bin/env python3
"""Boot/reset the verified public VM with the production PID-1 owner.

Uses fresh private Docker resources, no host ports/socket, no candidate or
official task. TCG must be explicitly selected; it is not a silent KVM fallback.
"""
import argparse
import hashlib
import json
from pathlib import Path
import secrets
import struct
import subprocess
import tempfile
import time
import uuid

CLIENT = r'''
import json,sys,time,urllib.request,urllib.error
from pathlib import Path
args=json.load(sys.stdin)
if args['kind']=='control':
    session=json.loads(Path('/control/session.json').read_text())
    payload={k:session[k] for k in ('lease_id','epoch')}
    payload.update(operation=args['operation'],request_id=args['request_id'])
    request=urllib.request.Request('http://127.0.0.1:8770/control',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+session['token']})
    deadline=time.monotonic()+10
    while True:
        try:
            response=urllib.request.urlopen(request,timeout=args['timeout']);break
        except urllib.error.HTTPError as error:
            import re
            raw=error.read(8193)
            try: kind=json.loads(raw).get('error') if len(raw)<=8192 else None
            except (ValueError,AttributeError): kind=None
            if not isinstance(kind,str) or not re.fullmatch('[A-Za-z][A-Za-z0-9_]{0,63}',kind): kind=None
            sys.stderr.write(json.dumps({'control_http_status':error.code,'control_error_type':kind})+'\n')
            raise
        except urllib.error.URLError:
            if time.monotonic()>=deadline: raise
            time.sleep(.2)
elif args['kind']=='screenshot':
    response=urllib.request.urlopen('http://127.0.0.1:5000/screenshot',timeout=15)
else:
    payload={'command':['python3','-c',args['script']],'shell':False,'timeout':15}
    request=urllib.request.Request('http://127.0.0.1:5000/setup/execute',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
    response=urllib.request.urlopen(request,timeout=20)
with response:
    data=response.read(16*1024*1024+1)
    assert len(data)<=16*1024*1024
sys.stdout.buffer.write(data)
'''


def run(args, timeout=60, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, **kwargs)


def main(args):
    output = Path(args.output).resolve()
    images = output.with_name(output.stem + '-screenshots')
    if output.exists() or images.exists(): raise ValueError('canary requires fresh output paths')
    if not 30 <= args.boot_timeout <= 1800: raise ValueError('invalid VM boot deadline')
    image_id = json.loads(run(['docker', 'image', 'inspect', args.image, '--format', '{{json .Id}}']).stdout)
    capacity = json.loads(run(['docker', 'info', '--format', '{"memory":{{.MemTotal}},"cpus":{{.NCPU}}}']).stdout)
    if capacity['memory'] < 6 * 1024**3 or capacity['cpus'] < 4:
        raise ValueError('VM component canary needs host headroom for a 4 GiB guest and controller processes')
    name = 'hitch-oswvm-' + uuid.uuid4().hex[:12]
    network, storage = name + '-net', name + '-storage'
    created = []
    receipt = {'protocol': 'osworld-vm-component-canary@1', 'image_id': image_id, 'passed': False,
               'official_task': False, 'real_scored_tasks': 0, 'guest_boot_verified': False,
               'acceleration': args.acceleration, 'guest_cpus': 4, 'guest_memory_bytes': 4 * 1024**3,
               'container_memory_bytes': 5 * 1024**3, 'boot_timeout_sec': args.boot_timeout,
               'host_capacity': capacity, 'resource_prefix': name, 'network_policy': args.network_policy}
    output.parent.mkdir(parents=True, exist_ok=True)
    images.mkdir()
    with tempfile.TemporaryDirectory(prefix='hitch-vm-session-') as private:
        session = {'lease_id': name, 'epoch': 1, 'logical_trial_id': name, 'token': secrets.token_hex(32)}
        session_file = Path(private) / 'session.json'
        session_file.write_text(json.dumps(session)); session_file.chmod(0o600)
        def request(kind, **fields):
            payload = {'kind': kind, **fields}
            return run(['docker', 'exec', '-i', name, '/usr/bin/python3', '-c', CLIENT],
                       timeout=args.boot_timeout + 30 if kind == 'control' else 30,
                       input=json.dumps(payload).encode()).stdout
        def control(operation):
            return json.loads(request('control', operation=operation, request_id=uuid.uuid4().hex, timeout=args.boot_timeout + 15))
        def screenshot(label):
            data = request('screenshot')
            if data[:8] != b'\x89PNG\r\n\x1a\n' or len(data) < 24: raise ValueError('guest did not return a PNG')
            file = images / (label + '.png'); file.write_bytes(data)
            width, height = struct.unpack('>II', data[16:24])
            return {'file': str(file), 'bytes': len(data), 'sha256': 'sha256:' + hashlib.sha256(data).hexdigest(), 'width': width, 'height': height}
        try:
            network_command = ['docker', 'network', 'create', '--label', 'org.agent-hitch.canary=' + name]
            if args.network_policy == 'isolated': network_command.append('--internal')
            run(network_command + [network]); created.append('network')
            internal = run(['docker', 'network', 'inspect', network, '--format', '{{.Internal}}']).stdout.strip() == b'true'
            if internal != (args.network_policy == 'isolated'): raise ValueError('network policy was not applied')
            receipt['network_internal'] = internal
            run(['docker', 'volume', 'create', '--label', 'org.agent-hitch.canary=' + name, storage]); created.append('volume')
            command = ['docker', 'run', '-d', '--name', name, '--platform', 'linux/amd64', '--network', network,
                       '--label', 'org.agent-hitch.canary=' + name, '--cpus', '4', '--memory', '5g', '--pids-limit', '256',
                       '--mount', 'type=bind,src=' + private + ',dst=/control,readonly',
                       '--mount', 'type=volume,src=' + storage + ',dst=/storage',
                       '-e', 'KVM=' + ('Y' if args.acceleration == 'kvm' else 'N'),
                       '-e', 'VM_BOOT_TIMEOUT_SEC=' + str(args.boot_timeout)]
            if args.acceleration == 'kvm': command += ['--device', '/dev/kvm']
            command.append(image_id)
            created.append('container'); run(command)
            bindings = json.loads(run(['docker', 'inspect', name, '--format', '{{json .HostConfig.PortBindings}}']).stdout)
            mounts = json.loads(run(['docker', 'inspect', name, '--format', '{{json .Mounts}}']).stdout)
            if bindings or any('docker.sock' in m['Source'] for m in mounts): raise ValueError('unexpected host exposure')
            receipt['artifact'] = json.loads(run(['docker', 'exec', name, 'cat', '/hitch-vm/vm-artifact.json']).stdout)
            if receipt['artifact']['archive_sha256'] != 'sha256:eb737ae70b49849e24af407de6a518439a23de05a8497096a948334ce0a909aa':
                raise ValueError('VM image differs from the benchmark release')
            started = time.monotonic(); first = control('start')
            if first.get('ready') is not True or first.get('generation') != 1: raise ValueError('first boot was not confirmed')
            check_monitor = '''import socket
with socket.socket() as client:
    client.settimeout(2)
    assert client.connect_ex(('127.0.0.1',7100)) != 0, 'unmanaged QEMU monitor is listening'
print('monitor disabled')'''
            run(['docker', 'exec', name, '/usr/bin/python3', '-c', check_monitor])
            receipt.update(guest_boot_verified=True, initial_boot_sec=round(time.monotonic() - started, 2), first_boot=first, first_screenshot=screenshot('first'))
            print(json.dumps({'phase': 'guest_booted', 'seconds': receipt['initial_boot_sec']}), flush=True)
            marker = '/tmp/' + name
            changed = json.loads(request('execute', script='from pathlib import Path; Path(' + repr(marker) + ').write_text("owned canary marker")'))
            if changed.get('returncode') != 0: raise ValueError('guest marker write failed')
            started = time.monotonic(); reset = control('reset')
            if reset.get('ready') is not True or reset.get('generation') != 2: raise ValueError('reset did not create another guest generation')
            clean = json.loads(request('execute', script='from pathlib import Path; assert not Path(' + repr(marker) + ').exists()'))
            if clean.get('returncode') != 0: raise ValueError('guest mutable state survived reset')
            receipt.update(reset_verified=True, reset_sec=round(time.monotonic() - started, 2), reset=reset, reset_screenshot=screenshot('reset'))
            receipt['close'] = control('close')
            if receipt['close'].get('closed') is not True: raise ValueError('VM owner did not confirm closure')
            overlay = json.loads(run(['docker', 'exec', name, 'qemu-img', 'info', '--output=json', '/boot.qcow2']).stdout)
            if overlay.get('backing-filename') != '/System.qcow2' or overlay.get('virtual-size') != receipt['artifact']['qcow2']['virtual_size_bytes']:
                raise ValueError('guest overlay did not preserve the official backing disk')
            receipt['overlay'] = overlay
            check_base = '''import hashlib,json
from pathlib import Path
sha=hashlib.sha256()
with Path('/System.qcow2').open('rb') as stream:
    for block in iter(lambda:stream.read(8*1024*1024),b''): sha.update(block)
processes=[]
for path in Path('/proc').glob('[0-9]*/comm'):
    try:
        if path.read_text().strip().startswith('qemu'): processes.append(int(path.parent.name))
    except OSError: pass
print(json.dumps({'base_sha256':'sha256:'+sha.hexdigest(),'qemu_processes':processes}))'''
            after_close = json.loads(run(['docker', 'exec', name, '/usr/bin/python3', '-c', check_base], timeout=300).stdout)
            if after_close['base_sha256'] != receipt['artifact']['image_sha256'] or after_close['qemu_processes']:
                raise ValueError('VM closure or immutable base preservation failed')
            receipt['after_close'] = after_close
            receipt.update(passed=True, no_host_ports_or_docker_socket_verified=True)
        except Exception as exc:
            receipt['error_type'] = type(exc).__name__
            if isinstance(exc, subprocess.CalledProcessError): receipt['diagnostic'] = exc.stderr.decode(errors='replace')[-2000:]
            raise
        finally:
            if 'container' in created:
                try:
                    logs = subprocess.run(['docker', 'logs', name], capture_output=True, timeout=30)
                    output.with_suffix('.container.log').write_bytes(logs.stdout + logs.stderr)
                except Exception as exc: receipt['log_collection_error'] = type(exc).__name__
            cleanup = []
            if 'container' in created: cleanup.append(['docker', 'rm', '-f', name])
            if 'volume' in created: cleanup.append(['docker', 'volume', 'rm', storage])
            if 'network' in created: cleanup.append(['docker', 'network', 'rm', network])
            for command in cleanup:
                try: subprocess.run(command, capture_output=True, timeout=60)
                except Exception as exc: receipt.setdefault('cleanup_errors', []).append(type(exc).__name__)
            remaining = {}
            try:
                for kind, command in [('containers', ['ps', '-aq']), ('volumes', ['volume', 'ls', '-q']), ('networks', ['network', 'ls', '-q'])]:
                    remaining[kind] = len(run(['docker', *command, '--filter', 'label=org.agent-hitch.canary=' + name]).stdout.split())
                receipt['remaining_owned_resources'] = remaining
                receipt['cleanup_passed'] = all(count == 0 for count in remaining.values())
            except Exception as exc:
                receipt['cleanup_verification_error'] = type(exc).__name__
                receipt['cleanup_passed'] = False
            if not receipt['cleanup_passed']: receipt['passed'] = False
            output.write_text(json.dumps(receipt, indent=2) + '\n')
            if not receipt['cleanup_passed']: raise RuntimeError('owned VM canary cleanup failed')
    print(json.dumps({'receipt': str(output), 'passed': receipt['passed'], 'official_task': False}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--acceleration', required=True, choices=['kvm', 'tcg'])
    parser.add_argument('--boot-timeout', type=int, default=900)
    parser.add_argument('--network-policy', choices=['isolated', 'egress'], default='isolated')
    main(parser.parse_args())

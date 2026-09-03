#!/usr/bin/env python3
"""Bounded public-VM desktop diagnostic; no candidate or official task.

The first boot waits for GNOME's systemd readiness, sends a graphical terminal
shortcut, and checks that the window manager registers a terminal. Retained PNGs
still require visual review. The underlying VM canary then checks clean reset,
immutable base bytes, process shutdown, and resource cleanup. The second boot
does not repeat the desktop probe.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import time

import osworld_vm_container_canary as vm


CLIENT = r'''
import json,sys,urllib.request
args=json.load(sys.stdin)
request=urllib.request.Request('http://127.0.0.1:5000/execute',data=json.dumps({'command':['python','-c',args['script']],'shell':False}).encode(),headers={'Content-Type':'application/json'})
with urllib.request.urlopen(request,timeout=args['timeout']) as response:
 data=response.read(1024*1024+1)
 assert len(data)<=1024*1024
 sys.stdout.buffer.write(data)
'''

PROBE = r'''
import json,subprocess
result={}
commands={
 'shell':['systemctl','--user','show','org.gnome.Shell@x11.service','--property=ActiveState','--property=SubState','--property=NRestarts','--property=Result'],
 'windows':['wmctrl','-lx'],
}
for key,command in commands.items():
 try:
  p=subprocess.run(command,capture_output=True,timeout=10)
  result[key]={'returncode':p.returncode,'stdout':p.stdout.decode(errors='replace')[:8192],'stderr':p.stderr.decode(errors='replace')[:1024]}
 except Exception as e:result[key]={'error_type':type(e).__name__}
print(json.dumps(result))
'''

JOURNAL = r'''
import json,subprocess
try:
 p=subprocess.run(['journalctl','--user','-b','--no-pager','-n','100','-o','cat','_COMM=gnome-shell'],capture_output=True,timeout=15)
 result={'returncode':p.returncode,'stdout':p.stdout.decode(errors='replace')[:24000],'stderr':p.stderr.decode(errors='replace')[:1024]}
except Exception as e:result={'error_type':type(e).__name__}
print(json.dumps(result))
'''


def main(args):
    output = Path(args.output).resolve()
    directory = output.with_name(output.stem + '-desktop')
    if output.exists() or directory.exists():
        raise ValueError('desktop canary requires fresh output paths')
    directory.mkdir(parents=True)
    original_run = vm.run
    generation = 0
    receipt = {
        'protocol': 'osworld-desktop-ready-canary@1',
        'official_task': False, 'real_scored_tasks': 0,
        'cpu_model_override': args.cpu_model,
        'desktop_timeout_sec': args.desktop_timeout,
        'terminal_timeout_sec': args.terminal_timeout,
        'gnome_service_ready': False, 'terminal_window_registered': False,
        'desktop_readiness_verified': False,
        'scope': 'First-boot GNOME service and graphical terminal-window registration; original PNGs need visual review. Second boot checks VM reset only.',
        'source_sha256': 'sha256:' + hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'vm_canary_sha256': 'sha256:' + hashlib.sha256(Path(vm.__file__).read_bytes()).hexdigest(),
        'observations': [],
    }

    def save():
        (directory / 'result.json').write_text(json.dumps(receipt, indent=2) + '\n')

    def observed_run(command, timeout=60, **kwargs):
        nonlocal generation
        if command[:3] == ['docker', 'run', '-d'] and args.cpu_model:
            command = [*command[:-1], '-e', 'CPU_MODEL=' + args.cpu_model, command[-1]]
        result = original_run(command, timeout=timeout, **kwargs)
        if command[:3] != ['docker', 'exec', '-i'] or command[-1:] != [vm.CLIENT]:
            return result
        request = json.loads(kwargs.get('input', b'{}'))
        if request.get('kind') != 'screenshot':
            return result
        generation += 1
        if generation != 1:
            return result
        name = command[3]
        receipt['resource_prefix'] = name
        (directory / 'initial.png').write_bytes(result.stdout)
        started = time.monotonic()

        def execute(script, request_timeout=30):
            response = original_run(['docker', 'exec', '-i', name, '/usr/bin/python3', '-c', CLIENT],
                                   timeout=request_timeout + 10,
                                   input=json.dumps({'script': script, 'timeout': request_timeout}).encode())
            value = json.loads(response.stdout)
            if value.get('returncode') != 0:
                raise RuntimeError('guest diagnostic or input request failed')
            return value

        def sample(label, deadline):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('desktop diagnostic wait budget expired')
            value = execute(PROBE, min(30, remaining))
            probe = json.loads(value['output'])
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('desktop diagnostic wait budget expired before screenshot')
            png = original_run(['docker', 'exec', '-i', name, '/usr/bin/python3', '-c', vm.CLIENT],
                               timeout=min(30, remaining), input=b'{"kind":"screenshot"}').stdout
            if png[:8] != b'\x89PNG\r\n\x1a\n':
                raise ValueError('desktop probe did not return a PNG')
            (directory / (label + '.png')).write_bytes(png)
            (directory / (label + '.json')).write_text(json.dumps(value, indent=2) + '\n')
            entry = {'label': label, 'elapsed_sec': round(time.monotonic() - started, 2),
                     'screenshot_sha256': 'sha256:' + hashlib.sha256(png).hexdigest(),
                     'shell': probe['shell'], 'windows': probe['windows']}
            receipt['observations'].append(entry)
            save()
            print(json.dumps({'phase': 'desktop_readiness_probe', 'label': label,
                              'elapsed_sec': entry['elapsed_sec'],
                              'shell': probe['shell'].get('stdout', '').strip(),
                              'terminal_window_registered': 'gnome-terminal' in probe['windows'].get('stdout', '').lower()}), flush=True)
            return probe

        try:
            deadline = started + args.desktop_timeout
            index = 0
            while True:
                probe = sample('shell-' + str(index).zfill(3), deadline)
                properties = dict(line.split('=', 1) for line in probe['shell'].get('stdout', '').splitlines() if '=' in line)
                if properties.get('ActiveState') == 'active' and properties.get('SubState') == 'running':
                    receipt['gnome_service_ready'] = True
                    receipt['gnome_service_ready_sec'] = round(time.monotonic() - started, 2)
                    save()
                    break
                if time.monotonic() >= deadline:
                    raise TimeoutError('GNOME did not become active within the desktop wait budget')
                time.sleep(min(15, max(0, deadline - time.monotonic())))
                index += 1
            action = execute("import pyautogui; pyautogui.FAILSAFE=False; pyautogui.moveTo(960,540,duration=0.2); pyautogui.press('shift'); pyautogui.hotkey('ctrl','alt','t')", 90)
            (directory / 'terminal-shortcut.json').write_text(json.dumps(action, indent=2) + '\n')
            deadline = time.monotonic() + args.terminal_timeout
            index = 0
            while True:
                time.sleep(min(5, max(0, deadline - time.monotonic())))
                probe = sample('terminal-' + str(index).zfill(3), deadline)
                windows = probe['windows']
                if windows.get('returncode') == 0 and 'gnome-terminal' in windows.get('stdout', '').lower():
                    receipt['terminal_window_registered'] = True
                    receipt['terminal_registered_sec'] = round(time.monotonic() - started, 2)
                    save()
                    break
                if time.monotonic() >= deadline:
                    raise TimeoutError('graphical shortcut did not produce a terminal window')
                index += 1
        except Exception as error:
            receipt['error_type'] = type(error).__name__
            raise
        finally:
            try:
                value = execute(JOURNAL, 30)
                (directory / 'gnome-journal.json').write_text(json.dumps(value, indent=2) + '\n')
            except Exception as error:
                receipt['journal_collection_error'] = type(error).__name__
            receipt['probe_duration_sec'] = round(time.monotonic() - started, 2)
            save()
        return result

    save()
    vm.run = observed_run
    try:
        vm.main(args)
    finally:
        vm.run = original_run


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--acceleration', required=True, choices=['kvm', 'tcg'])
    parser.add_argument('--cpu-model')
    parser.add_argument('--boot-timeout', type=int, default=900)
    parser.add_argument('--network-policy', choices=['isolated', 'egress'], default='egress')
    parser.add_argument('--desktop-timeout', type=int, default=600)
    parser.add_argument('--terminal-timeout', type=int, default=90)
    args = parser.parse_args()
    if args.cpu_model and not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', args.cpu_model):
        parser.error('CPU model must be a simple QEMU model name')
    if args.acceleration == 'tcg' and not args.cpu_model:
        parser.error('TCG diagnostic requires an explicit CPU model')
    if not 30 <= args.desktop_timeout <= 900 or not 10 <= args.terminal_timeout <= 120:
        parser.error('desktop/terminal wait budget is out of range')
    main(args)

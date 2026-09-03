"""Real Docker check of the single-container static no-network provider path.

Run with Harbor 0.21.0's Python. No candidate model or official task is used.
"""
import argparse
import asyncio
import json
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'integrations/harbor'))
from harbor.models.task.config import EnvironmentConfig, NetworkMode, NetworkPolicy
from harbor.models.trial.paths import TrialPaths
from hitch_harbor_environment import HitchHarborDockerEnvironment


async def main(args):
    output = Path(args.output).resolve()
    if output.exists(): raise ValueError('fresh canary output required')
    image = subprocess.check_output(['docker', 'image', 'inspect', args.image, '--format', '{{.Id}}'], text=True).strip()
    suffix = uuid.uuid4().hex
    session = 'hitch-static-network-' + suffix[:12]
    labels = {'io.hitch.root-id': suffix[:24], 'io.hitch.provider': 'local-docker',
              'io.hitch.eval-id': 'eval_' + suffix, 'io.hitch.work-id': 'work_' + suffix,
              'io.hitch.lease-id': 'lease_' + suffix, 'io.hitch.lease-epoch': '1', 'io.hitch.task-id': 'static-network-canary'}
    receipt = {'protocol': 'hitch-static-network-canary@1', 'image_id': image, 'official_task': False, 'passed': False}
    with tempfile.TemporaryDirectory(prefix='hitch-static-network-') as temporary:
        root = Path(temporary)
        directory = root / 'environment'; directory.mkdir()
        paths = TrialPaths(root / 'trial'); paths.mkdir()
        policy = NetworkPolicy(network_mode=NetworkMode.NO_NETWORK)
        env = HitchHarborDockerEnvironment(environment_dir=directory, environment_name='static-network-canary', session_id=session,
            trial_paths=paths, task_env_config=EnvironmentConfig(docker_image=image, cpus=1, memory_mb=128),
            network_policy=policy, phase_network_policies=[policy], hitch_ownership_labels=labels)
        try:
            assert env.capabilities.disable_internet and not env.capabilities.dynamic_network_policy
            assert not env._enable_egress_control
            await env.start(False)
            receipt['engine'] = env._hitch_static_network_receipt
            probe = r'''const fs=require('fs'); const net=require('net'); const os=require('os');
(async()=>{
 const sysfs_interfaces=fs.readdirSync('/sys/class/net');
 // Docker Desktop can expose unconfigured kernel tunnel templates in sysfs.
 // Check addressed interfaces, routing and actual connections instead.
 const interfaces=os.networkInterfaces();
 if(Object.keys(interfaces).some(k=>k!=='lo')||!interfaces.lo?.every(a=>a.internal))throw new Error('unexpected addressed network interface');
 const routes=fs.readFileSync('/proc/net/route','utf8').trim().split('\n').slice(1);
 if(routes.length)throw new Error('unexpected IPv4 route');
 const server=net.createServer(s=>s.end('local')).listen(0,'127.0.0.1');
 await new Promise(r=>server.once('listening',r));
 const loopback=await new Promise((resolve,reject)=>{let text='';const s=net.connect(server.address().port,'127.0.0.1');s.on('data',d=>text+=d);s.on('end',()=>resolve(text));s.on('error',reject)});
 server.close(); if(loopback!=='local')throw new Error('loopback failed');
 const errors=[];
 for(const host of ['1.1.1.1','192.168.65.2','2606:4700:4700::1111']){
  errors.push(await new Promise((resolve,reject)=>{const s=net.connect(443,host);s.setTimeout(1000);s.on('connect',()=>{s.destroy();reject(new Error('external network reachable'))});s.on('error',e=>resolve(e.code));s.on('timeout',()=>{s.destroy();reject(new Error('expected immediate no-route rejection'))})}));
 }
 if(errors.some(e=>e!=='ENETUNREACH'))throw new Error('unexpected egress failure');
 console.log(JSON.stringify({sysfs_interfaces,interfaces,ipv4_route_count:routes.length,loopback:true,egress_errors:errors}));
})().catch(e=>{console.error(e.message);process.exitCode=1});'''
            result = await env.exec('node -e ' + shlex.quote(probe), timeout_sec=10)
            receipt['probe_execution'] = {'exit_code': result.return_code, 'stdout': (result.stdout or '')[:4096], 'stderr': (result.stderr or '')[:4096]}
            if result.return_code != 0: raise RuntimeError('network namespace probe failed: ' + (result.stderr or result.stdout or ''))
            receipt['network_probe'] = json.loads(result.stdout)
            await env.set_network_policy(policy)
            try:
                await env.set_network_policy(NetworkPolicy(network_mode=NetworkMode.PUBLIC))
                raise AssertionError('static network was reopened')
            except ValueError:
                receipt['runtime_reopen_rejected'] = True
            receipt['passed'] = True
        except BaseException as exc:
            receipt['error_type'] = type(exc).__name__
            raise
        finally:
            try:
                await env.stop(delete=True)
            finally:
                remaining = {}
                for kind, command in [('containers', ['ps', '-aq']), ('networks', ['network', 'ls', '-q']), ('volumes', ['volume', 'ls', '-q'])]:
                    result = subprocess.run(['docker', *command, '--filter', 'label=io.hitch.lease-id=lease_' + suffix], capture_output=True, text=True, check=True)
                    remaining[kind] = len(result.stdout.split())
                receipt['remaining_owned_resources'] = remaining
                receipt['cleanup_passed'] = all(v == 0 for v in remaining.values())
                if not receipt['cleanup_passed']: receipt['passed'] = False
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text(json.dumps(receipt, indent=2) + '\n')
                if not receipt['cleanup_passed']: raise RuntimeError('owned canary cleanup failed')
    print(json.dumps(receipt))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', default='node:22.23.0-bookworm-slim')
    parser.add_argument('--output', required=True)
    asyncio.run(main(parser.parse_args()))

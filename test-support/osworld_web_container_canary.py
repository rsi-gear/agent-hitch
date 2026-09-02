#!/usr/bin/env python3
"""Verify the real Budgetwise images behind the compiled private static router.

No official OSWorld task, VM, candidate or score. Images must be built from the
pinned source separately; resulting image IDs are included in the receipt.
Only an owned Compose project and its volumes are removed on exit.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'benchmark-packages/osworld'))
from web_routes import router_compose


CLIENT = r'''
import http.cookiejar,json,re,time,urllib.request,urllib.error
base='http://budgetwise.trial.hitch.test'
def client():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
a,b=client(),client()
def request(opener,path,method='GET',data=None):
    headers={'Content-Type':'application/json'} if data is not None else {}
    req=urllib.request.Request(base+path,method=method,headers=headers,data=json.dumps(data).encode() if data is not None else None)
    with opener.open(req,timeout=5) as response:
        return response.headers, response.read()
deadline=time.monotonic()+90
while True:
    try:
        _,raw=request(a,'/api/state');initial=json.loads(raw);break
    except (OSError,ValueError):
        if time.monotonic()>deadline: raise
        time.sleep(1)
headers,html=request(a,'/')
assert 'text/html' in headers['Content-Type']
assets=re.findall(r'(?:src|href)="(/assets/[^"\s]+)"',html.decode())
assert assets
for asset in assets:
    _,content=request(a,asset);assert content
payload={'data':{'hitch_canary':'isolated'},'note':'owned component test'}
_,raw=request(a,'/api/state','PUT',payload)
assert json.loads(raw)['state']['data']==payload['data']
_,raw=request(b,'/api/state');other=json.loads(raw)
assert other['user_id']!=initial['user_id'] and 'hitch_canary' not in other['state']['data']
_,raw=request(a,'/api/state');assert json.loads(raw)['state']['data']==payload['data']
_,raw=request(a,'/api/state','DELETE');assert json.loads(raw)['state']['data']==initial['state']['data']
_,raw=request(a,'/api/state');assert json.loads(raw)['state']['data']==initial['state']['data']
# A GET is not an MCP session. Its protocol rejection/response must come from
# the backend, not the frontend fallback. No MCP tool is invoked.
req=urllib.request.Request(base+'/mcp/',headers={'Accept':'text/event-stream'})
try:
    response=a.open(req,timeout=5)
except urllib.error.HTTPError as exc:
    response=exc
with response:
    assert response.headers.get('x-request-id')
    assert 'text/html' not in response.headers.get('Content-Type','')
    mcp_status=response.status
print(json.dumps({'html_and_assets':True,'assets_fetched':len(assets),'api_get_put_delete':True,'separate_cookie_state':True,'state_reset':True,'mcp_backend_route':True,'mcp_get_status':mcp_status}))
'''


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180, **kwargs)


def main(args):
    output = Path(args.output).resolve()
    if output.exists(): raise ValueError('receipt already exists')
    router = Path(args.router_directory).resolve()
    plan = json.loads((router / 'routes.json').read_text())
    if plan['namespace'] != 'trial.hitch.test' or {row['app'] for row in plan['routes']} != {'budgetwise_web'}:
        raise ValueError('canary requires only the pinned Budgetwise route')
    if plan['router_dns_aliases'] != ['budgetwise.trial.hitch.test'] or plan['requires_private_ca_trust']:
        raise ValueError('canary requires the default Budgetwise HTTP namespace')
    config = (router / 'Caddyfile').read_bytes()
    if 'sha256:' + hashlib.sha256(config).hexdigest() != plan['caddyfile_sha256']:
        raise ValueError('compiled route bytes differ from the plan')
    state = Path(args.state_file).resolve(strict=True)
    if not state.is_file(): raise ValueError('upstream STATE.md is required')
    compose = router_compose(plan, plan['router_image'])
    if compose != json.loads((router / 'docker-compose.proxy.yaml').read_text()):
        raise ValueError('router Compose fragment differs from the compiler contract')
    proxy = compose['services']['web_proxy']
    proxy['volumes'][0] = str(router / 'Caddyfile') + ':/etc/caddy/Caddyfile:ro'
    compose['services'].update({
        'budgetwise_web_backend': {'image': args.backend_image, 'platform': 'linux/amd64',
            'environment': {'API_PREFIX': '/api', 'ENV': 'production'}, 'networks': ['web'],
            'volumes': [str(state) + ':/app/STATE.md:ro'], 'cpus': 0.5, 'mem_limit': '512m', 'pids_limit': 64},
        'budgetwise_web_frontend': {'image': args.frontend_image, 'platform': 'linux/amd64',
            'networks': ['web'], 'cpus': 0.25, 'mem_limit': '128m', 'pids_limit': 64},
    })
    proxy['platform'] = 'linux/amd64'
    images = {name: json.loads(run(['docker', 'image', 'inspect', value['image'], '--format', '{{json .Id}}']).stdout)
              for name, value in compose['services'].items()}
    client_image = json.loads(run(['docker', 'image', 'inspect', args.client_image, '--format', '{{json .Id}}']).stdout)
    project = 'hitch-web-canary-' + uuid.uuid4().hex[:12]
    receipt = {'protocol': 'osworld-web-component-canary@1', 'project': project, 'passed': False,
               'official_task': False, 'official_vm': False, 'real_scored_tasks': 0,
               'website_commit': plan['website_commit'], 'sources': plan['sources'],
               'router_config_sha256': plan['caddyfile_sha256'], 'image_ids': images,
               'client_image_id': client_image, 'state_file_sha256': hashlib.sha256(state.read_bytes()).hexdigest()}
    with tempfile.TemporaryDirectory(prefix='hitch-web-canary-') as temporary:
        compose_path = Path(temporary) / 'compose.json'
        compose_path.write_text(json.dumps(compose))
        command = ['docker', 'compose', '-p', project, '-f', str(compose_path)]
        try:
            run(command + ['up', '-d', '--no-build', '--pull', 'never'])
            ids = run(command + ['ps', '-q']).stdout.split()
            if len(ids) != 3: raise ValueError('not all website services started')
            for container in ids:
                info = json.loads(run(['docker', 'inspect', container, '--format', '{{json .HostConfig.PortBindings}}']).stdout)
                if info: raise ValueError('website canary must not publish host ports')
                mounts = json.loads(run(['docker', 'inspect', container, '--format', '{{json .Mounts}}']).stdout)
                if any('docker.sock' in mount['Source'] for mount in mounts): raise ValueError('Docker socket exposed')
            networks = [project + '_web', project + '_vm']
            for network in networks:
                if run(['docker', 'network', 'inspect', network, '--format', '{{.Internal}}']).stdout.strip() != 'true':
                    raise ValueError('website networks must be internal')
            result = run(['docker', 'run', '--rm', '-i', '--name', project + '-client', '--platform', 'linux/amd64',
                          '--network', project + '_vm', '--cpus', '0.5', '--memory', '128m', '--pids-limit', '64',
                          '--entrypoint', 'python', args.client_image, '-'], input=CLIENT)
            receipt['checks'] = json.loads(result.stdout)
            receipt.update(passed=True, private_networks_verified=True, no_host_ports_or_docker_socket_verified=True)
        except Exception as exc:
            receipt['error_type'] = type(exc).__name__
            # Only owned public-application diagnostics; no environment inspection.
            if isinstance(exc, subprocess.CalledProcessError): receipt['diagnostic'] = exc.stderr[-4000:]
            raise
        finally:
            subprocess.run(['docker', 'rm', '-f', project + '-client'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
            cleanup = subprocess.run(command + ['down', '--volumes', '--remove-orphans'], capture_output=True, text=True, timeout=90)
            receipt['cleanup_passed'] = cleanup.returncode == 0
            if cleanup.returncode: receipt['passed'] = False
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(receipt, indent=2) + '\n')
            if cleanup.returncode: raise RuntimeError('owned canary cleanup failed')
    print(json.dumps({'receipt': str(output), 'passed': receipt['passed'], 'official_task': False}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('router-directory', 'backend-image', 'frontend-image', 'client-image', 'state-file', 'output'):
        parser.add_argument('--' + name, required=True)
    main(parser.parse_args())

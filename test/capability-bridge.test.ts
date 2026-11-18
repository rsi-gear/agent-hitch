import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("actual isolation observations are required before an opt-in runtime can launch the Agent",()=>{
 const script=String.raw`
import asyncio,json,sys
from types import SimpleNamespace
sys.path.insert(0,'integrations/harbor')
import hitch_capabilities as m
binding={'id':'service','service':'worker','entrypoint':'/opt/service/run.py','source':{'sha256':'sha256:'+'a'*64},'max_action_seconds':60,'dependencies':{'python':'3.11','example':'1.2.3'},'dependency_packages':{'example':'example'}}
base={'HostConfig':{'NetworkMode':'none','NanoCpus':1000000000,'Memory':536870912,'PidMode':'','Privileged':False},'Mounts':[]}
class Env:
 _hitch_service_resource_limits={'worker':{'cpu_millis':1000,'memory_bytes':536870912}}
 async def service_exec(self,*a,**kw):return SimpleNamespace(return_code=0,stdout=json.dumps({'source_digest':binding['source']['sha256'],'runtime':{'python':'3.11.18','example':'1.2.3'}}))
 async def _run_docker_compose_command(self,*a):return SimpleNamespace(return_code=0,stdout='a'*64)
class Child:
 returncode=0
 async def communicate(self):return json.dumps([facts]).encode(),b''
async def launch(*a,**kw):return Child()
m.asyncio.create_subprocess_exec=launch
async def run():
 global facts
 async def authority(command,request):return {}
 env=Env();owner=SimpleNamespace(state={'bindings':[binding]},env=env,agent=SimpleNamespace(hitch_timeout_ms=60000),call=authority)
 facts=json.loads(json.dumps(base));await m.CapabilitySession(owner).prepare()
 variants=[('NetworkMode','bridge'),('NanoCpus',2000000000),('Memory',1073741824),('Privileged',True),('PidMode','container:other')]
 for key,value in variants:
  facts=json.loads(json.dumps(base));facts['HostConfig'][key]=value
  try:await m.CapabilitySession(owner).prepare();raise AssertionError('accepted '+key)
  except RuntimeError as e:assert 'unsupported_constraint' in str(e)
 facts=json.loads(json.dumps(base));facts['Mounts']=[{'Source':'/candidate'}]
 try:await m.CapabilitySession(owner).prepare();raise AssertionError('accepted mount')
 except RuntimeError as e:assert 'unsupported_constraint' in str(e)
asyncio.run(run())
`;
 const result=spawnSync(process.env.HITCH_TEST_PYTHON??"python3",["-c",script],{encoding:"utf8"});assert.equal(result.status,0,result.stderr+result.stdout);
});
test("private verifier evidence uses only the host trial root and ignores mounted Agent log receipts",()=>{
 const script=String.raw`
import asyncio,json,sys,tempfile
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,'integrations/harbor')
from hitch_capabilities import restore_capability_evidence
class Env:
 async def exec(self,command):return SimpleNamespace(return_code=0)
 async def upload_file(self,source,target):self.body=Path(source).read_text();self.target=target
async def run():
 with tempfile.TemporaryDirectory() as folder:
  root=Path(folder);task=root/'task';(task/'environment').mkdir(parents=True)
  (task/'parameters.json').write_text(json.dumps({'capability_bindings':[{'id':'trusted'}]}))
  trial=root/'trial';(trial/'agent').mkdir(parents=True)
  (trial/'agent/parameter-evidence.json').write_text('{"forged":true}')
  source=trial/'parameter-evidence.json';source.write_text('{"source":"host_parameter_authority","authentic":true}')
  env=Env();verifier=SimpleNamespace(task=SimpleNamespace(paths=SimpleNamespace(environment_dir=task/'environment')),trial_paths=SimpleNamespace(trial_dir=trial),environment=env)
  await restore_capability_evidence(verifier);assert json.loads(env.body)['authentic'] is True;assert env.target=='/hitch-constraints/parameter-evidence.json'
  source.unlink()
  try:await restore_capability_evidence(verifier);raise AssertionError('accepted forged mounted logs')
  except RuntimeError as error:assert 'unavailable' in str(error)
asyncio.run(run())
`;
 const result=spawnSync(process.env.HITCH_TEST_PYTHON??"python3",["-c",script],{encoding:"utf8"});assert.equal(result.status,0,result.stderr+result.stdout);
});

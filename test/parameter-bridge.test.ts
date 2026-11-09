import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

test("Harbor parameter bridge retains host authority, records rejected proposals and exposes no protocol requirement to ordinary tasks", () => {
  const python = process.env.HITCH_TEST_PYTHON ?? "python3";
  const script = String.raw`
import asyncio, importlib.util, json, tempfile
from pathlib import Path
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location("hitch_parameters", "integrations/harbor/hitch_parameters.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
contract = {"version":1,"parameters":{"method":{"folds":5,"seed":42}},"schema":{"type":"object","required":["method"],"additionalProperties":False,"properties":{"method":{"type":"object","required":["folds","seed"],"additionalProperties":False,"properties":{"folds":{"type":"integer"},"seed":{"type":"integer"}}}}},"parameter_policy":{"/method/folds":{"mutable":True,"actors":["target"],"apply_at":"training_start","minimum":3,"maximum":10},"/method/seed":{"mutable":False}}}
class Env:
 def __init__(self, root):
  self.environment_dir = root/'task/environment'; self.environment_dir.mkdir(parents=True)
  self.trial_paths = SimpleNamespace(trial_dir=root/'trial'); self.trial_paths.trial_dir.mkdir()
  self.files = {}; self.requests=[]
 async def upload_file(self, file, dest): self.files[dest] = Path(file).read_bytes()
 async def exec(self, command):
  if command.startswith('python3 -c'):
   rows=self.requests; self.requests=[]
   return SimpleNamespace(return_code=0,stdout=json.dumps(rows))
  return SimpleNamespace(return_code=0,stdout='')
async def run():
 with tempfile.TemporaryDirectory() as temp:
  root=Path(temp); env=Env(root)
  runtime=root/'runtime'; runtime.mkdir(); (runtime/'payload').symlink_to(Path.cwd())
  agent=SimpleNamespace(hitch_runtime_dir=runtime,_artifact_host_directory=None,benchmark_revision='data@1',revision_identity='harness@1',controller_runtime_id='runtime@1',eval_id='e1',logs_dir=root/'logs',_trial_identity=lambda: ('trial','task',1))
  absent=m.ParameterSession(agent,env); assert await absent.start() is False; await absent.stop()
  (env.environment_dir.parent/'parameters.json').write_text(json.dumps(contract))
  session=m.ParameterSession(agent,env); assert await session.start()
  session.monitor.cancel()
  try: await session.monitor
  except asyncio.CancelledError: pass
  session.monitor=None
  env.files['/tmp/hitch-parameters.json']=b'{"policy":"forged sandbox copy"}'
  env.requests=[{'id':'a'*32,'request':{'action':'good','parameters':{'method':{'folds':7,'seed':42}}}}, {'id':'b'*32,'request':{'action':'bad','parameters':{'method':{'folds':8,'seed':99}}}}]
  await session.drain()
  # A mounted Agent log symlink must never become a host write destination.
  agent.logs_dir.mkdir(); victim=root/'victim'; victim.write_text('unchanged')
  (agent.logs_dir/'parameter-evidence.json').symlink_to(victim)
  await session.stop(); assert victim.read_text()=='unchanged'
  good=json.loads(env.files['/tmp/hitch-parameter-channel/'+'a'*32+'.response.json'])
  bad=json.loads(env.files['/tmp/hitch-parameter-channel/'+'b'*32+'.response.json'])
  assert good['accepted'] and not bad['accepted']
  state=json.loads(session.state_file.read_text()); assert state['effective']=={'method':{'folds':7,'seed':42}}
  assert any(not r['accepted'] and r['path']=='/method/seed' for r in state['audit'])
  evidence=json.loads((session.state_file.parent/'parameter-evidence.json').read_text()); assert evidence['execution_compliance']=='unverified'
  assert evidence['source']=='host_parameter_authority' and evidence['evidence_error'] is None
asyncio.run(run())
`;
  const result = spawnSync(python, ["-c", script], { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

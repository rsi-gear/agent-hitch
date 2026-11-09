import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("same-task attempts use exact host identities and reject shared Compose state", () => {
 const script=String.raw`
import json,sys,tempfile
from pathlib import Path
sys.path.insert(0,'integrations/harbor')
from hitch_attempt_isolation import project_name,inspect_task,assert_resolved
with tempfile.TemporaryDirectory() as folder:
 root=Path(folder);(root/'environment').mkdir();(root/'tests').mkdir();(root/'task.toml').write_text('[environment]\ncpus=1\n')
 labels={'work':'work-a','epoch':'1'}
 a=project_name(labels,'Task__A__env',root/'trial-a');b=project_name(labels,'task__a__env',root/'trial-a')
 assert a!=b and len(a)<64 and a==project_name(labels,'Task__A__env',root/'trial-a')
 assert a!=project_name({**labels,'epoch':'2'},'Task__A__env',root/'trial-a')
 assert a!=project_name(labels,'Task__A__env',root/'trial-b')
 compose={'services':{'main':{'image':'pinned@sha256:'+'a'*64,'volumes':['scratch:/work']},'db':{'image':'db:1'}},'volumes':{'scratch':{}},'networks':{'private':{}}}
 file=root/'environment/docker-compose.yaml';file.write_text(json.dumps(compose));assert inspect_task(root)['supported']
 for field,value in [('container_name','same'),('ports',['8080:80']),('volumes',['/tmp/shared:/work']),('network_mode','host'),('pid','host'),('configs',['shared'])]:
  changed=json.loads(json.dumps(compose));changed['services']['main'][field]=value;file.write_text(json.dumps(changed));assert not inspect_task(root)['supported'],field
 for kind,value in [('volumes',{'scratch':{'name':'global'}}),('networks',{'private':{'external':True}}),('configs',{'x':{'file':'/tmp/shared'}})]:
  changed=json.loads(json.dumps(compose));changed[kind]=value;file.write_text(json.dumps(changed));assert not inspect_task(root)['supported'],kind
 trial=root/'trial-a';trial.mkdir();resolved={'services':{'main':{'volumes':[{'type':'bind','source':str(trial/'agent'),'target':'/logs/agent'}]}},'networks':{'default':{'name':a+'_default'}}}
 assert_resolved(resolved,a,trial)
 resolved['services']['main']['volumes'][0]['source']=str(root/'trial-b'/'agent')
 try:assert_resolved(resolved,a,trial);raise AssertionError('cross-trial bind accepted')
 except ValueError:pass
 resolved['services']['main']['volumes']=[{'type':'bind','source':str(root/'immutable'),'target':'/opt/hitch','read_only':True}]
 assert_resolved(resolved,a,trial,(str(root/'immutable'),))
 resolved['services']['main']['volumes'][0]['read_only']=False
 try:assert_resolved(resolved,a,trial,(str(root/'immutable'),));raise AssertionError('mutable shared installation accepted')
 except ValueError:pass
`;
 const result=spawnSync(process.env.HITCH_TEST_PYTHON??"python3",["-c",script],{encoding:"utf8"});assert.equal(result.status,0,result.stderr+result.stdout);
});

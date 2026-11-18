#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
if (process.argv.includes('--version')) { console.log('pi 1.0.0'); process.exit(0); }
const script = `import csv,json,pathlib,subprocess,copy
state=json.loads(subprocess.check_output(['python3','/tmp/hitch-parameters.py','show']))
parameters=state['effective']
parameters['method']['cv']['folds']=4
pathlib.Path('/tmp/proposal.json').write_text(json.dumps(parameters))
accepted=subprocess.run(['python3','/tmp/hitch-parameters.py','submit','training-1','/tmp/proposal.json'],capture_output=True,text=True)
assert accepted.returncode==0,accepted.stdout+accepted.stderr
replay=subprocess.run(['python3','/tmp/hitch-parameters.py','submit','training-1','/tmp/proposal.json'],capture_output=True,text=True)
assert replay.returncode==0,replay.stdout+replay.stderr
forbidden=copy.deepcopy(parameters);forbidden['method']['cv']['seed']=43
pathlib.Path('/tmp/forbidden.json').write_text(json.dumps(forbidden))
rejected=subprocess.run(['python3','/tmp/hitch-parameters.py','submit','locked-seed','/tmp/forbidden.json'],capture_output=True,text=True)
assert rejected.returncode==1,rejected.stdout+rejected.stderr
assert 'cannot change /method/cv/seed' in rejected.stdout,rejected.stdout
print(json.dumps({'accepted':json.loads(accepted.stdout)['accepted'],'replay':json.loads(replay.stdout)['reason'],'rejected':json.loads(rejected.stdout)['reason']}))
from sklearn.preprocessing import FunctionTransformer
from sklearn.dummy import DummyClassifier
from sklearn.pipeline import Pipeline
files=list(pathlib.Path('/data').rglob('train.csv'))
assert len(files)==1, files
rows=list(csv.DictReader(files[0].open()))
model=Pipeline([('ordinary_python_closure',FunctionTransformer(lambda x:x)),('model',DummyClassifier(strategy='constant',constant=1))])
model.fit([[float(r['x'])] for r in rows],[int(r['label']) for r in rows])
pred=model.predict([[101.0],[102.0]])
pathlib.Path('/output').mkdir(exist_ok=True)
with open('/output/submission.csv','w') as f:
 w=csv.writer(f);w.writerow(['id','label']);w.writerows(zip([101,102],pred))
print(json.dumps({'training':'ordinary sklearn Pipeline with lambda transformer','predictions':len(pred)}))
`;
const result=spawnSync('python3',['-c',script],{encoding:'utf8',maxBuffer:65536});
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:result.stdout+result.stderr}],stopReason:result.status===0?'stop':'error'}}));
process.exitCode=result.status??1;

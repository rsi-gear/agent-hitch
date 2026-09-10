import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Process fixture: rejects candidate commands and private source configuration. No Docker or model execution. */
export async function writeRemoteVerifierProcess(root: string) {
  const bin = path.join(root, "scoring-bin"); await mkdir(bin);
  const docker = path.join(bin, "docker"); await writeFile(docker,
    `#!${process.execPath}\nif (process.argv[2] === "info") console.log(JSON.stringify({ID: "fixture-verifier-docker-engine"}));\n`, { mode: 0o755 });
  const harbor = path.join(bin, "harbor");
  await writeFile(harbor, `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path';
if (process.argv.includes('--version')) { console.log('harbor 0.21.0'); process.exit(0); }
if (process.argv[2] !== 'trials' || process.argv[3] !== 'start') throw Error('candidate execution forbidden');
const config = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--config')+1]));
if (config.source_trial.action !== 'regrade' || config.agent.kwargs || JSON.stringify(config).includes('private-agent-token')) throw Error('private candidate execution');
const source = JSON.parse(fs.readFileSync(path.join(config.source_trial.path, 'result.json')));
if (fs.readFileSync(path.join(config.source_trial.path, 'artifacts/patch.diff'), 'utf8') !== 'original patch\\n') throw Error('candidate artifacts changed');
const output = path.join(config.trials_dir, config.trial_name); fs.mkdirSync(path.join(output, 'verifier'), {recursive:true});
fs.writeFileSync(path.join(output, 'verifier/test-stdout.txt'), 'tests passed');
fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({...source, config, trial_name:config.trial_name,
 agent_setup:null, agent_execution:null, verifier_result:{rewards:{reward:1,total_score:1}}}));
`, { mode: 0o755 });
  return { harbor, docker, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } };
}

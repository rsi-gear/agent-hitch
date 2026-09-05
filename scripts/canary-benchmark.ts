/** Explicit Docker canary. Fixture harness is deterministic and calls no model. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { validateBenchmark } from "../src/benchmarks/index.js";
import { exportStandardBenchmarkDataset, runEval } from "../src/evals/index.js";
import { atomicWriteJSON, runCommand } from "../src/foundation/index.js";
import { writeBenchmarkFixture } from "../test-support/benchmark-fixture.js";

if (process.argv[2] !== "--fixture") throw new Error("Usage: node dist/scripts/canary-benchmark.js --fixture");
const directory = await mkdtemp(path.join(tmpdir(), "hitch-benchmark-canary-"));
const packageDir = path.join(directory, "package");
await writeBenchmarkFixture(packageDir, { benchmark: "runtime-created-counter", task: "reach-seven", tool: "bump_value", metric: "goal_met" });
await validateBenchmark(packageDir);
const dataset = path.join(directory, "dataset");
await exportStandardBenchmarkDataset(packageDir, dataset);
const harnessDir = path.join(directory, "harness");
await mkdir(harnessDir);
const metadata = { name: "hitch-benchmark-deterministic-fixture", version: "1.0.0", private: true, scripts: { build: "node build.js" } };
await atomicWriteJSON(path.join(harnessDir, "package.json"), metadata);
await atomicWriteJSON(path.join(harnessDir, "package-lock.json"), { name: metadata.name, version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: metadata.name, version: "1.0.0" } } });
const code = `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('pi 1.0.0'); process.exit(0); }
const fs=require('node:fs'), child=require('node:child_process');
let prompt=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', x=>prompt+=x);
process.stdin.on('end',()=>{
 const binding=JSON.parse(fs.readFileSync('/tmp/hitch-tool-binding.json','utf8'));
 const result=child.execFileSync(process.execPath,['/tmp/hitch-tools.mjs',binding.tools[0].name,JSON.stringify({amount:7})],{encoding:'utf8'});
 console.log(JSON.stringify({type:'session',version:3,id:'fixture_session',cwd:process.cwd()}));
 console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:result}}));
 console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:result}],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop'}}));
});
`;
await writeFile(path.join(harnessDir, "build.js"), `const fs=require('node:fs'); fs.mkdirSync('packages/coding-agent/dist',{recursive:true}); fs.writeFileSync('packages/coding-agent/dist/cli.js',${JSON.stringify(code)},{mode:0o755});\n`);
await runCommand("git", ["init", harnessDir]);
await runCommand("git", ["-C", harnessDir, "add", "."]);
await runCommand("git", ["-C", harnessDir, "-c", "user.name=Hitch Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "deterministic tool-server canary"]);
const revision = (await runCommand("git", ["-C", harnessDir, "rev-parse", "HEAD"])).stdout.trim();
console.log(JSON.stringify({ directory, candidate: "deterministic-fixture", revision }));
const result = await runEval({
  root: path.resolve(".hitch/benchmark-fixture-state"),
  request: { dataset, harness_ref: `pi@git+${pathToFileURL(harnessDir).href}#${revision}`, model: "fixture", max_concurrent: 1, attempts: 1 },
  onEvent: (event) => console.log(JSON.stringify(event)),
});
await atomicWriteJSON(path.join(directory, "result.json"), result);
assert.equal(result.exit_code, 0, JSON.stringify(result));
// A score must be present and one, proving the candidate called the new tool.
const resultText = await readFile(path.join(directory, "result.json"), "utf8");
assert.match(resultText, /"reward":\s*1/);
assert.match(resultText, /"total_score":\s*1/);
console.log(JSON.stringify({ passed: true, directory, result }, null, 2));

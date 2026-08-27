import { chmod, readdir, rm, writeFile } from "node:fs/promises";
import { lstat } from "node:fs/promises";
import path from "node:path";

/**
 * Remove a tree even when it contains read-only controller runtime bundles
 * (spec §4.5 makes promoted payloads 0555/0444; plain `rm -rf` then fails to
 * unlink inside read-only directories).
 */
export async function forceRemove(directory: string): Promise<void> {
  await chmodWritableRecursive(directory);
  await rm(directory, { recursive: true, force: true });
}

async function chmodWritableRecursive(directory: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    try {
      if (entry.isDirectory()) {
        await chmodWritableRecursive(absolute);
        await chmod(absolute, 0o700);
      } else {
        await chmod(absolute, 0o600);
      }
    } catch {
      // Best effort; the outer rm may still succeed.
    }
  }
}

export async function writeFakeCodex(directory: string, { delayMs = 0, exitCode = 0, splitReply = false }: { delayMs?: number; exitCode?: number; splitReply?: boolean } = {}): Promise<string> {
  const file = path.join(directory, "fake-codex");
  const source = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 9.9.9\\n");
  process.exit(0);
}
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  setTimeout(() => {
    process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"thread_fake"}) + "\\n");
    ${splitReply
      ? 'process.stdout.write(JSON.stringify({type:"item.completed",item:{id:"item_1",type:"agent_message",text:"reply:"}}) + "\\n");\n    process.stdout.write(JSON.stringify({type:"item.completed",item:{id:"item_2",type:"agent_message",text:prompt}}) + "\\n");'
      : 'process.stdout.write(JSON.stringify({type:"item.completed",item:{id:"item_1",type:"agent_message",text:"reply:" + prompt}}) + "\\n");'}
    process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:2}}) + "\\n");
    process.exit(${exitCode});
  }, ${delayMs});
});
`;
  await writeFile(file, source, { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}

export async function writeFakePi(directory: string): Promise<string> {
  const file = path.join(directory, "fake-pi");
  const source = fakePiSource();
  await writeFile(file, source, { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}

export function fakePiSource(version = "0.82.1"): string {
  return `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("pi ${version}\\n");
  process.exit(0);
}
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const usage = {input:1,output:2,cacheRead:0,cacheWrite:0,totalTokens:3,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
  process.stdout.write(JSON.stringify({type:"session",version:3,id:"pi_session",cwd:process.cwd()}) + "\\n");
  process.stdout.write(JSON.stringify({type:"message_update",assistantMessageEvent:{type:"text_delta",contentIndex:0,delta:"reply:"}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"message_update",assistantMessageEvent:{type:"text_delta",contentIndex:0,delta:prompt}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"reply:" + prompt}],usage,stopReason:"stop"}}) + "\\n");
});
`;
}

export async function writeFakeNpm(directory: string, {
  version = "1.2.3",
  installedIntegrity = "sha512-fake-integrity",
  installDelayMs = 0,
  packageName = "@earendil-works/pi-coding-agent",
  binName = "pi",
}: {
  version?: string;
  installedIntegrity?: string;
  installDelayMs?: number;
  packageName?: string;
  binName?: string;
} = {}): Promise<string> {
  const file = path.join(directory, "fake-npm");
  const installedHarness = packageName === "@earendil-works/pi-coding-agent" && binName === "pi"
    ? fakePiSource(version)
    : `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write(${JSON.stringify(binName)} + " " + ${JSON.stringify(version)} + "\\n");
  process.exit(0);
}
process.stdout.write("{}\\n");
`;
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("10.9.0\\n");
  process.exit(0);
}
if (args[0] === "view") {
  process.stdout.write(JSON.stringify({
    version: ${JSON.stringify(version)},
    dist: {
      integrity: "sha512-fake-integrity",
      tarball: "https://registry.example.test/pi-${version}.tgz"
    }
  }));
  process.exit(0);
}
if (args[0] === "install") {
  setTimeout(() => {
    const bin = path.join(process.cwd(), "node_modules", ".bin");
    const packageRoot = path.join(process.cwd(), "node_modules", ...${JSON.stringify(packageName.split("/"))});
    fs.mkdirSync(bin, {recursive:true});
    fs.mkdirSync(path.join(packageRoot, "dist"), {recursive:true});
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
      name:${JSON.stringify(packageName)},
      version:${JSON.stringify(version)},
      bin:{[${JSON.stringify(binName)}]:"dist/cli.js"}
    }));
    fs.writeFileSync(path.join(packageRoot, "dist", "cli.js"), ${JSON.stringify(installedHarness)}, {mode:0o755});
    fs.writeFileSync(path.join(process.cwd(), "package-lock.json"), JSON.stringify({
      lockfileVersion:3,
      packages:{
        [${JSON.stringify(`node_modules/${packageName}`)}]:{
          version:${JSON.stringify(version)},
          integrity:${JSON.stringify(installedIntegrity)}
        }
      }
    }));
    process.exit(0);
  }, ${installDelayMs});
  return;
}
process.stderr.write("unsupported fake npm invocation: " + args.join(" ") + "\\n");
process.exit(2);
`;
  await writeFile(file, source, { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}

export async function writeFakeDeepseekNpm(directory: string, {
  version = "0.1.0-rc.7",
}: { version?: string } = {}): Promise<string> {
  const file = path.join(directory, "fake-dsh-npm");
  const installedDsh = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write(${JSON.stringify(version)} + "\\n");
  process.exit(0);
}
process.stdout.write("reply:hello\\n");
`;
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(directory, "fake-dsh-npm.log"))}, JSON.stringify(args) + "\\n");
if (args[0] === "--version") {
  process.stdout.write("10.9.0\\n");
  process.exit(0);
}
if (args[0] === "view") {
  process.stdout.write(JSON.stringify({
    version: ${JSON.stringify(version)},
    dist: {
      integrity: "sha512-fake-integrity",
      tarball: "https://registry.example.test/dsh-${version}.tgz"
    }
  }));
  process.exit(0);
}
if (args[0] === "pack") {
  const destination = args[args.indexOf("--pack-destination") + 1];
  const filename = "deepseek-ai-dsh-${version}.tgz";
  fs.writeFileSync(path.join(destination, filename), "fake archive");
  process.stdout.write(JSON.stringify([{
    name: "@deepseek-ai/dsh",
    version: ${JSON.stringify(version)},
    integrity: "sha512-fake-integrity",
    filename
  }]));
  process.exit(0);
}
if (args[0] === "install" && args.includes("--global")) {
  const prefix = args[args.indexOf("--prefix") + 1];
  const packageRoot = path.join(prefix, "lib", "node_modules", "@deepseek-ai", "dsh");
  fs.mkdirSync(path.join(packageRoot, "lib"), {recursive:true});
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "@deepseek-ai/dsh",
    version: ${JSON.stringify(version)},
    bin: {dsh: "lib/bin.js"}
  }));
  fs.writeFileSync(path.join(packageRoot, "lib", "bin.js"), ${JSON.stringify(installedDsh)}, {mode:0o755});
  process.exit(0);
}
process.stderr.write("unsupported fake npm invocation: " + args.join(" ") + "\\n");
process.exit(2);
`;
  await writeFile(file, source, { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}

export async function writeFakeHarbor(directory: string): Promise<string> {
  const file = path.join(directory, "fake-harbor");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("harbor 0.1.0\\n");
  process.exit(0);
}
const configIndex = args.indexOf("--config");
if (args[0] !== "run" || configIndex < 0 || !args.includes("--yes")) {
  process.stderr.write("unexpected Harbor invocation: " + args.join(" ") + "\\n");
  process.exit(2);
}
const config = JSON.parse(fs.readFileSync(args[configIndex + 1], "utf8"));
const output = path.join(config.jobs_dir, config.job_name);
const logicalAttempt = config.agents[0].kwargs.logical_attempt || 1;
const trials = [
  {task_name:"one",trial_name:"one__random-" + logicalAttempt,verifier_result:{rewards:{reward:1}}},
  {task_name:"two",trial_name:"two__random-" + logicalAttempt,verifier_result:{rewards:{reward:0.5}}}
];
fs.mkdirSync(output, {recursive:true});
fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({
  n_total_trials: trials.length,
  stats: {n_completed_trials: trials.length, n_errored_trials: 0, n_cancelled_trials: 0}
}));
for (const trial of trials) {
  const trialOutput = path.join(output, trial.trial_name);
  fs.mkdirSync(trialOutput, {recursive:true});
  fs.writeFileSync(path.join(trialOutput, "result.json"), JSON.stringify(trial));
}
process.stdout.write("Results written\\n");
`;
  await writeFile(file, source, { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}

export async function writeFakePython(directory: string, { version = "3.12.9" }: { version?: string } = {}): Promise<string> {
  const file = path.join(directory, "fake-python");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "-c") {
  process.stdout.write(${JSON.stringify(version)} + "\\n");
  process.exit(0);
}
if (args[0] === "-m" && args[1] === "venv") {
  const target = args[2];
  const bin = path.join(target, "bin");
  fs.mkdirSync(bin, {recursive:true});
  fs.copyFileSync(process.argv[1], path.join(bin, "python"));
  fs.chmodSync(path.join(bin, "python"), 0o755);
  process.exit(0);
}
if (args[0] === "-m" && args[1] === "pip" && args[2] === "install") {
  const spec = args.find((value) => value.startsWith("harbor=="));
  const harborVersion = spec ? spec.slice("harbor==".length) : "0.0.0";
  const harbor = path.join(path.dirname(process.argv[1]), "harbor");
  fs.writeFileSync(harbor, "#!/usr/bin/env node\\nprocess.stdout.write(" + JSON.stringify(harborVersion + "\\n") + ");\\n", {mode:0o755});
  process.exit(0);
}
process.stderr.write("unexpected fake Python invocation: " + args.join(" ") + "\\n");
process.exit(2);
`;
  await writeFile(file, source, { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}

export async function writeFakeDocker(directory: string, { daemonRunning = true }: { daemonRunning?: boolean } = {}): Promise<string> {
  const file = path.join(directory, "fake-docker");
  const source = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "version" && args.includes("--format")) {
  if (${JSON.stringify(daemonRunning)}) {
    process.stdout.write("27.4.0\\n");
    process.exit(0);
  }
  process.stderr.write("Cannot connect to the Docker daemon\\n");
  process.exit(1);
}
process.exit(2);
`;
  await writeFile(file, source, { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}

export async function writeFakeOpenCode(directory: string): Promise<string> {
  const file = path.join(directory, "fake-opencode");
  const source = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("opencode 1.18.15\\n");
  process.exit(0);
}
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const base = {timestamp:Date.now(),sessionID:"oc_session"};
  process.stdout.write(JSON.stringify({...base,type:"step_start",part:{id:"part_start",sessionID:base.sessionID,messageID:"message_1",type:"step-start"}}) + "\\n");
  process.stdout.write(JSON.stringify({...base,type:"text",part:{id:"part_text",sessionID:base.sessionID,messageID:"message_1",type:"text",text:"reply:" + prompt,time:{start:1,end:2}}}) + "\\n");
  process.stdout.write(JSON.stringify({...base,type:"step_finish",part:{id:"part_finish",sessionID:base.sessionID,messageID:"message_1",type:"step-finish",reason:"stop",cost:0,tokens:{input:1,output:2,reasoning:0,cache:{read:0,write:0}}}}) + "\\n");
});
`;
  await writeFile(file, source, { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}

export async function writeFakeDeepseek(directory: string, {
  output = "reply:hello",
  nativeSession = false,
  nativeChildSession = false,
  nativeSessionState = "complete",
  delayMs = 0,
  argvLog,
}: {
  output?: string;
  nativeSession?: boolean;
  nativeChildSession?: boolean;
  nativeSessionState?: "complete" | "open" | "invalid";
  delayMs?: number;
  argvLog?: string;
} = {}): Promise<string> {
  const file = path.join(directory, "fake-dsh");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.includes("--version")) {
  process.stdout.write("0.1.0-rc.6\\n");
  process.exit(0);
}
if (${JSON.stringify(argvLog)} !== undefined) {
  fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
}
const launcherArgs = process.argv.slice(2);
const finalPatch = launcherArgs.lastIndexOf("--patch");
const innerArgs = finalPatch < 0 ? launcherArgs.slice(2) : launcherArgs.slice(finalPatch + 2);
if (innerArgs[0]?.startsWith("-")) {
  process.stderr.write("error: unknown option '" + innerArgs[0] + "'\\n");
  process.exit(1);
}
const runtimePatches = finalPatch < 0 ? [] : JSON.parse(fs.readFileSync(launcherArgs[finalPatch + 1], "utf8"));
const unescapeLeadingLineBreak = runtimePatches.some((row) => Array.isArray(row.insert)
  && row.insert.some((entry) => entry.id === "hitch-headless-startup"
    && entry.config?.unescapeLeadingLineBreak === true));
let prompt = innerArgs.join(" ");
if (unescapeLeadingLineBreak) {
  if (!prompt.startsWith("\\n-")) throw new Error("fake-dsh: escaped task marker is missing");
  prompt = prompt.slice(1);
}
if (${JSON.stringify(nativeSession)}) {
  const base = 1700000000000;
  const header = {type:"session",version:0,id:"session-native",createdAt:base,cwd:process.cwd(),delegationDepth:0};
  const completeEvents = [
    {type:"permission/preset",seq:0,time:base + 1,data:{preset:"headless"}},
    {type:"turn/start",seq:1,time:base + 10,data:{turn:1}},
    {type:"step/start",seq:2,time:base + 20,data:{turn:1,step:1}},
    {type:"user/message",seq:3,time:base + 30,data:{id:"user-1",role:"user",content:[{type:"text",text:prompt}],source:{kind:"user"}},surfaceOp:"append"},
    {type:"request/header",seq:4,time:base + 40,data:{header:{config:{provider:"deepseek-official",model:"deepseek-v4-flash"}},reason:"initial"}},
    {type:"assistant/message",seq:5,time:base + 100,data:{turn:1,step:1,message:{id:"assistant-tool",role:"assistant",content:[{type:"tool-call",id:"call-1",name:"bash",arguments:"{\\\"command\\\":\\\"pwd\\\"}"}],source:{kind:"model",provider:"deepseek-official",model:"deepseek-v4-flash"}},usage:{inputTokens:11,outputTokens:3,cacheReadTokens:2,reasoningTokens:1}},surfaceOp:"append"},
    {type:"tool/call",seq:6,time:base + 110,data:{turn:1,step:1,callId:"call-1",name:"bash",arguments:"{\\\"command\\\":\\\"pwd\\\"}"}},
    {type:"tool/result",seq:7,time:base + 500,data:{turn:1,step:1,message:{id:"tool-1",role:"user",content:[{type:"tool-result",toolCallId:"call-1",content:[{type:"text",text:process.cwd()}],isError:false}],source:{kind:"tool",callId:"call-1"}}},surfaceOp:"append",sourceEventSeqs:[6]},
    {type:"step/end",seq:8,time:base + 510,data:{turn:1,step:1}},
    {type:"step/start",seq:9,time:base + 520,data:{turn:1,step:2}},
    {type:"assistant/chunk",seq:10,time:base + 700,data:{turn:1,step:2,chunk:{type:"usage",usage:{inputTokens:21,outputTokens:5,cacheReadTokens:4,reasoningTokens:2}}}},
    {type:"assistant/message",seq:11,time:base + 800,data:{turn:1,step:2,message:{id:"assistant-final",role:"assistant",content:[{type:"reasoning",text:"native reasoning"},{type:"text",text:"native final"}],source:{kind:"model",provider:"deepseek-official",model:"deepseek-v4-flash"}},usage:{inputTokens:21,outputTokens:5,cacheReadTokens:4,reasoningTokens:2}},sourceEventSeqs:[10],surfaceOp:"append"},
    {type:"step/end",seq:12,time:base + 810,data:{turn:1,step:2}},
    {type:"turn/end",seq:13,time:base + 820,data:{turn:1,reason:{kind:"completed"}}}
  ];
  const sessionState = ${JSON.stringify(nativeSessionState)};
  const events = sessionState === "open"
    ? completeEvents.slice(0, 11)
    : sessionState === "invalid"
      ? [completeEvents[0], completeEvents[1], {...completeEvents[1], seq:2, time:base + 20}]
      : completeEvents;
  const target = path.join(process.env.DSH_HOME, "sessions", "--fake--", "session-native", "session.jsonl");
  fs.mkdirSync(path.dirname(target), {recursive:true});
  fs.writeFileSync(target, [header, ...events].map((row) => JSON.stringify(row)).join("\\n") + "\\n");
  if (${JSON.stringify(nativeChildSession)}) {
    const childHeader = {type:"session",version:0,id:"session-child",createdAt:base + 200,parentSession:"session-native",origin:"subagent",delegationDepth:1};
    const childEvents = [
      {type:"turn/start",seq:0,time:base + 210,data:{turn:1}},
      {type:"step/start",seq:1,time:base + 220,data:{turn:1,step:1}},
      {type:"assistant/message",seq:2,time:base + 230,data:{turn:1,step:1,message:{id:"child-final",role:"assistant",content:[{type:"text",text:"child final"}],source:{kind:"model",provider:"deepseek-official",model:"deepseek-v4-flash"}}}},
      {type:"step/end",seq:3,time:base + 240,data:{turn:1,step:1}},
      {type:"turn/end",seq:4,time:base + 250,data:{turn:1,reason:{kind:"completed"}}}
    ];
    const childTarget = path.join(process.env.DSH_HOME, "sessions", "--fake--", "session-child", "session.jsonl");
    fs.mkdirSync(path.dirname(childTarget), {recursive:true});
    fs.writeFileSync(childTarget, [childHeader, ...childEvents].map((row) => JSON.stringify(row)).join("\\n") + "\\n");
  }
}
const finish = () => process.stdout.write(${JSON.stringify(output)} + "\\n");
if (${delayMs} > 0) setTimeout(finish, ${delayMs});
else finish();
`;
  await writeFile(file, source, { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}

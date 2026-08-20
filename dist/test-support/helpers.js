import { chmod, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
/**
 * Remove a tree even when it contains read-only controller runtime bundles
 * (spec §4.5 makes promoted payloads 0555/0444; plain `rm -rf` then fails to
 * unlink inside read-only directories).
 */
export async function forceRemove(directory) {
    await chmodWritableRecursive(directory);
    await rm(directory, { recursive: true, force: true });
}
async function chmodWritableRecursive(directory) {
    let entries;
    try {
        entries = await readdir(directory, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        try {
            if (entry.isDirectory()) {
                await chmodWritableRecursive(absolute);
                await chmod(absolute, 0o700);
            }
            else {
                await chmod(absolute, 0o600);
            }
        }
        catch {
            // Best effort; the outer rm may still succeed.
        }
    }
}
export async function writeFakeCodex(directory, { delayMs = 0, exitCode = 0, splitReply = false } = {}) {
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
export async function writeFakePi(directory) {
    const file = path.join(directory, "fake-pi");
    const source = fakePiSource();
    await writeFile(file, source, { mode: 0o755 });
    await chmod(file, 0o755);
    return file;
}
export function fakePiSource(version = "0.82.1") {
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
export async function writeFakeNpm(directory, { version = "1.2.3", installedIntegrity = "sha512-fake-integrity", installDelayMs = 0, } = {}) {
    const file = path.join(directory, "fake-npm");
    const installedPi = fakePiSource(version);
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
    const packageRoot = path.join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent");
    fs.mkdirSync(bin, {recursive:true});
    fs.mkdirSync(path.join(packageRoot, "dist"), {recursive:true});
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({name:"@earendil-works/pi-coding-agent",version:${JSON.stringify(version)},bin:{pi:"dist/cli.js"}}));
    fs.writeFileSync(path.join(packageRoot, "dist", "cli.js"), ${JSON.stringify(installedPi)}, {mode:0o755});
    fs.writeFileSync(path.join(process.cwd(), "package-lock.json"), JSON.stringify({
      lockfileVersion:3,
      packages:{
        "node_modules/@earendil-works/pi-coding-agent":{
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
export async function writeFakeHarbor(directory) {
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
fs.mkdirSync(output, {recursive:true});
fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({
  n_total_trials: 2,
  stats: {n_completed_trials: 2, n_errored_trials: 0, n_cancelled_trials: 0}
}));
for (const trial of [
  {task_name:"one",trial_name:"one__1",verifier_result:{rewards:{reward:1}}},
  {task_name:"two",trial_name:"two__1",verifier_result:{rewards:{reward:0.5}}}
]) {
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
export async function writeFakePython(directory, { version = "3.12.9" } = {}) {
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
export async function writeFakeDocker(directory, { daemonRunning = true } = {}) {
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
export async function writeFakeOpenCode(directory) {
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
export async function writeFakeDeepseek(directory, { output = "reply:hello" } = {}) {
    const file = path.join(directory, "fake-dsh");
    const source = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("0.1.0-rc.6\\n");
  process.exit(0);
}
process.stdout.write(${JSON.stringify(output)} + "\\n");
`;
    await writeFile(file, source, { mode: 0o755 });
    await chmod(file, 0o755);
    return file;
}
//# sourceMappingURL=helpers.js.map
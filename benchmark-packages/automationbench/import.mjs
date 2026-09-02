#!/usr/bin/env node
// Independent source adapter: produces a standard package, imports no Hitch code.
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const base = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const source = option("--source") ?? "https://github.com/zapier/AutomationBench.git";
const ref = option("--ref");
const out = option("--out");
const tasks = [];
while (args.includes("--task")) tasks.push(option("--task"));
if (args.length || !out || !/^[a-f0-9]{40}$/.test(ref ?? "") || tasks.length === 0 || new Set(tasks).size !== tasks.length || tasks.some((t) => !/^[a-z]+\.[a-z0-9_]+$/.test(t))) {
  throw new Error("Usage: node import.mjs --source GIT --ref FULL_COMMIT --task ORIGINAL_ID [--task ORIGINAL_ID] --out NEW_DIRECTORY");
}
const output = path.resolve(out);
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output); // Never overwrite an existing package.
const temporary = await mkdtemp(path.join(os.tmpdir(), "hitch-source-adapter-"));
const python = "mirror.gcr.io/library/python@sha256:ed86c82274b3c69b52fb5820f358f0bd7df0b603332063cb5c6e32bd220c3e6e";
const node = "node@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2";
const runtimeDockerfile = `FROM ${python}\nRUN pip install --no-cache-dir uv==0.8.15\nCOPY runtime/upstream /opt/upstream\nWORKDIR /opt/upstream\nRUN uv sync --frozen --no-dev\nCOPY runtime /runtime\nENV PATH="/opt/upstream/.venv/bin:$PATH" PYTHONPATH="/runtime:/opt/upstream" PYTHONDONTWRITEBYTECODE=1 HF_HOME=/tmp/hf\n`;
const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + "\n");
try {
  const checkout = path.join(temporary, "source");
  await command("git", ["clone", "--no-checkout", source, checkout]);
  await command("git", ["-C", checkout, "checkout", "--detach", ref]);
  const actual = (await command("git", ["-C", checkout, "rev-parse", "HEAD"], true)).trim();
  if (actual !== ref) throw new Error("source revision mismatch");
  const runtime = path.join(output, "runtime");
  await cp(path.join(base, "runtime"), runtime, { recursive: true });
  await cp(fileURLToPath(import.meta.url), path.join(runtime, "source-adapter.mjs"));
  await cp(checkout, path.join(runtime, "upstream"), { recursive: true, filter: (file) => path.basename(file) !== ".git" });
  const build = path.join(temporary, "build"); await mkdir(build);
  await cp(runtime, path.join(build, "runtime"), { recursive: true });
  await writeFile(path.join(build, "Dockerfile"), runtimeDockerfile);
  const image = `hitch-source-adapter:${createHash("sha256").update(runtimeDockerfile + ref + await readFile(path.join(runtime, "official.py")) + await readFile(path.join(runtime, "export.py"))).digest("hex").slice(0, 24)}`;
  await command("docker", ["build", "--platform", "linux/amd64", "-t", image, build]);
  const exports = path.join(temporary, "exports"); await mkdir(exports);
  await command("docker", ["run", "--rm", "--platform", "linux/amd64", "--network", "none", "--read-only", "--tmpfs", "/tmp", "-v", `${exports}:/out`, image, "python", "/runtime/export.py", ...tasks.flatMap((t) => ["--task", t]), "--out", "/out/tasks.json"]);
  const rows = JSON.parse(await readFile(path.join(exports, "tasks.json"), "utf8"));
  const ids = rows.map((r) => r.id.replaceAll(".", "-"));
  await json(path.join(runtime, "tools.json"), rows[0].tools);
  await mkdir(path.join(output, "profiles")); await mkdir(path.join(output, "tasks"));
  const capabilities = ["shell", "artifact-export", "separate-verifier", "compose", "tool-server@1", "http-json-cli", "hitch-hook@1"];
  const profile = { schema_version: "1", id: "automationbench-public-api-hitch", track: "public-subset", input_mode: "instruction", tool_policy: { id: "api-shell-bridge-v1", allowed: capabilities, network: "open", enforcement: "required" }, budget: { agent_timeout: { source: "task" }, setup_timeout_ms: 1800000, collection_timeout_ms: 60000, cleanup_grace_ms: 30000 }, sampling: { attempts_per_task: 1, seed: 42 }, grading: { on_agent_budget_exhausted: "grade_final_state", on_missing_submission: "error", infrastructure_retries: 0 }, extensions: { toolset: "api", model_seed_supported: false, upstream_version: "1.0.6", protocol_note: "Public subset with shell CLI transport; not the private leaderboard evaluation." } };
  await json(path.join(output, "profiles/default.json"), profile);
  await writeFile(path.join(output, "benchmark.toml"), `schema_version = "1"\nprotocol = "hitch-benchmark@1"\nid = "automationbench-public"\nrelease = "${ref}"\ntask_root = "tasks"\ntask_ids = ${JSON.stringify(ids)}\ndefault_profile = "profiles/default.json"\nprimary_metric = "task_completed_correctly"\nruntime_components = [{ id = "official-simulator", protocol = "tool-server@1", path = "runtime" }]\n[task_format]\nname = "harbor"\nschema_version = "1.4"\n[source]\nkind = "git"\nuri = ${JSON.stringify(source.startsWith("https:") ? source : "https://github.com/zapier/AutomationBench.git")}\nresolved_revision = "${ref}"\nlicense = "MIT"\naccess = "public"\n[metrics.task_completed_correctly]\ntype = "binary"\ndirection = "maximize"\nrange = [0, 1]\nreducer = "task_macro_mean"\n[metrics.partial_credit]\ntype = "scalar"\ndirection = "maximize"\nrange = [0, 1]\nreducer = "task_macro_mean"\n[publication]\ntrack = "public-subset"\ntraining_eligible = false\n`);
  await json(path.join(output, "source-manifest.json"), { schema_version: "1", source_commit: ref, source_uri: "https://github.com/zapier/AutomationBench", toolset: "api", adapter: { id: "automationbench-public-source", version: "1", path: "runtime/source-adapter.mjs", digest: createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex") }, transformations: ids.map(id => ({kind: "message-prompt-to-instruction", before_path: `tasks/${id}/source-prompt.json`, after_path: `tasks/${id}/instruction.md`})), selection: "explicit-subset", excluded: "all unselected public tasks and the simple track", tasks: rows.map((r, i) => ({ task_id: ids[i], source_task_id: r.id, example_id: r.row.example_id, task_contract_sha256: r.contract_sha256 })), usage_conditions: "See runtime/upstream/LICENSE and upstream README; public subset is not private leaderboard reproduction." });
  for (const [index, item] of rows.entries()) {
    if (JSON.stringify(item.tools) !== JSON.stringify(rows[0].tools)) throw new Error("toolset schemas differ between selected tasks");
    const task = path.join(output, "tasks", ids[index]);
    await mkdir(path.join(task, "environment"), { recursive: true }); await mkdir(path.join(task, "tests"));
    await writeFile(path.join(task, "instruction.md"), item.row.prompt.map((p) => `## ${p.role}\n\n${p.content}`).join("\n\n") + "\n");
    await json(path.join(task, "source-prompt.json"), item.row.prompt);
    const lifecycle = Object.fromEntries(["prepare", "quiesce", "snapshot", "cleanup"].map((phase) => [phase, { protocol: "hitch-hook@1", target: "environment:simulator", argv: ["python", "/runtime/server.py", "hook"], timeout_ms: phase === "cleanup" ? 30000 : 60000 }]));
    await json(path.join(task, "task.hitch.json"), { schema_version: "1", source_task_id: item.id, driver: { kind: "tool-server", protocol_version: "1", config: { transport: "http-json-cli", endpoint: "http://simulator:8765/", schema: "runtime/tools.json", service: "simulator" } }, requirements: capabilities, lifecycle, submission: { kind: "artifacts", paths: ["/evidence/snapshot.json"], max_bytes: 104857600 }, grading: { kind: "command", entrypoint: ["bash", "/tests/test.sh"], metric_map: { partial_credit: "partial_credit", task_completed_correctly: "task_completed_correctly" } } });
    await writeFile(path.join(task, "task.toml"), `schema_version = "1.4"\nartifacts = [{ source = "/evidence/snapshot.json", service = "simulator" }]\n[metadata]\ncategory = "workflow"\n[agent]\ntimeout_sec = 600.0\n[environment]\ncpus = 1\nmemory_mb = 2048\nstorage_mb = 10240\nworkdir = "/app"\nnetwork_mode = "public"\n[verifier]\ntimeout_sec = 120.0\nenvironment_mode = "separate"\n[verifier.environment]\ncpus = 1\nmemory_mb = 2048\nnetwork_mode = "public"\n`);
    for (const area of ["environment", "tests"]) {
      await cp(runtime, path.join(task, area, "runtime"), { recursive: true });
      await json(path.join(task, area, "runtime/task.json"), item.row);
    }
    await writeFile(path.join(task, "environment/Dockerfile"), `FROM ${node}\nWORKDIR /app\nCMD ["sleep", "infinity"]\n`);
    await writeFile(path.join(task, "environment/Dockerfile.simulator"), runtimeDockerfile + 'COPY runtime/task.json /data/task.json\nCMD ["python", "/runtime/server.py"]\n');
    await writeFile(path.join(task, "environment/docker-compose.yaml"), JSON.stringify({ services: { main: { platform: "linux/amd64", build: { context: ".", dockerfile: "Dockerfile" }, command: ["sleep", "infinity"], depends_on: { simulator: { condition: "service_healthy" } } }, simulator: { platform: "linux/amd64", build: { context: ".", dockerfile: "Dockerfile.simulator" }, cpus: 1, mem_limit: "2g", healthcheck: { test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/health')"], interval: "2s", timeout: "2s", retries: 60 } } } }, null, 2));
    await writeFile(path.join(task, "tests/Dockerfile"), runtimeDockerfile + 'COPY runtime/task.json /data/task.json\nCOPY test.sh /tests/test.sh\nCMD ["sleep", "infinity"]\n');
    await writeFile(path.join(task, "tests/test.sh"), "#!/bin/bash\nset -euo pipefail\npython /runtime/official.py /data/task.json /evidence/snapshot.json /logs/verifier\n");
  }
  console.log(JSON.stringify({ package: output, source_commit: ref, task_ids: ids }, null, 2));
} catch (error) {
  await rm(output, { recursive: true, force: true });
  throw error;
} finally { await rm(temporary, { recursive: true, force: true }); }

async function command(executable, argv, capture = false) {
  return new Promise((resolve, reject) => {
    const process = spawn(executable, argv, { stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"] });
    let stdout = "";
    process.stdout?.on("data", (chunk) => { stdout += chunk; });
    process.on("error", reject);
    process.on("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${executable} exited ${code}`)));
  });
}

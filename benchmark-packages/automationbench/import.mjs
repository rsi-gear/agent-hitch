#!/usr/bin/env node
// Independent source adapter: produces a standard package, imports no Hitch code.
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
const candidateDockerfile = `FROM ${python}\nCOPY runtime/call.py runtime/tools.json /runtime/\nWORKDIR /app\nCMD ["sleep", "infinity"]\n`;
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
  const adapterRevision = `sha256:${createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex")}`;
  await json(path.join(output, "source-manifest.json"), { schema_version: "1", source_commit: ref, source_uri: "https://github.com/zapier/AutomationBench", toolset: "api", adapter: { id: "automationbench-public-source", version: "4", path: "runtime/source-adapter.mjs", digest: adapterRevision }, transformations: ids.map(id => ({kind: "message-prompt-to-instruction", before_path: `${id}/source-prompt.json`, after_path: `${id}/instruction.md`})), selection: "explicit-subset", excluded: "all unselected public tasks and the simple track", tasks: rows.map((r, i) => ({ task_id: ids[i], source_task_id: r.id, example_id: r.row.example_id, task_contract_sha256: r.contract_sha256 })), usage_conditions: "See runtime/upstream/LICENSE and upstream README; public subset is not private leaderboard reproduction." });
  for (const [index, item] of rows.entries()) {
    if (JSON.stringify(item.tools) !== JSON.stringify(rows[0].tools)) throw new Error("toolset schemas differ between selected tasks");
    const task = path.join(output, ids[index]);
    await mkdir(path.join(task, "environment"), { recursive: true }); await mkdir(path.join(task, "tests"));
    const toolInstructions = `\n\n## Available tools\n\nThis task has a local AutomationBench API server. Tool schemas are in \`/runtime/tools.json\`. Invoke a tool with:\n\n\`python /runtime/call.py TOOL_NAME '{"argument":"value"}'\`\n\nUse only listed tools and pass a JSON object as the final argument.\n`;
    await writeFile(path.join(task, "instruction.md"), item.row.prompt.map((p) => `## ${p.role}\n\n${p.content}`).join("\n\n") + toolInstructions);
    await json(path.join(task, "source-prompt.json"), item.row.prompt);
    await writeFile(path.join(task, "task.toml"), `schema_version = "1.4"\nartifacts = [{ source = "/evidence/snapshot.json", service = "simulator" }]\n[metadata]\ncategory = "workflow"\ndomain = ${JSON.stringify(item.id.split(".")[0])}\nsource_task_id = ${JSON.stringify(item.id)}\n[agent]\ntimeout_sec = 600.0\n[environment]\ncpus = 1\nmemory_mb = 2048\nstorage_mb = 10240\nworkdir = "/app"\nnetwork_mode = "public"\n[verifier]\ntimeout_sec = 120.0\nenvironment_mode = "separate"\n[verifier.environment]\ncpus = 1\nmemory_mb = 2048\nnetwork_mode = "public"\n`);
    for (const area of ["environment", "tests"]) {
      await cp(runtime, path.join(task, area, "runtime"), { recursive: true });
      await json(path.join(task, area, "runtime/task.json"), item.row);
    }
    await writeFile(path.join(task, "environment/Dockerfile"), candidateDockerfile);
    await writeFile(path.join(task, "environment/Dockerfile.simulator"), runtimeDockerfile + 'COPY runtime/task.json /data/task.json\nCMD ["python", "/runtime/server.py"]\n');
    await writeFile(path.join(task, "environment/docker-compose.yaml"), JSON.stringify({
      services: {
        main: {
          platform: "linux/amd64",
          build: { context: ".", dockerfile: "Dockerfile" },
          depends_on: { simulator: { condition: "service_healthy" } },
          environment: { AUTOMATIONBENCH_API_URL: "http://simulator:8765" },
        },
        simulator: {
          platform: "linux/amd64",
          build: { context: ".", dockerfile: "Dockerfile.simulator" },
          healthcheck: {
            test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/health', timeout=2)"],
            interval: "2s",
            timeout: "3s",
            retries: 30,
            start_period: "10s",
          },
        },
      },
    }, null, 2));
    await writeFile(path.join(task, "tests/Dockerfile"), runtimeDockerfile + 'COPY runtime/task.json /data/task.json\nCOPY test.sh /tests/test.sh\nCMD ["sleep", "infinity"]\n');
    await writeFile(path.join(task, "tests/test.sh"), "#!/bin/bash\nset -euo pipefail\npython /runtime/official.py /data/task.json /evidence/snapshot.json /logs/verifier\n");
  }
  const taskEntries = (await Promise.all(ids.map(async taskId => ({ task_id: taskId, task_digest: await treeDigest(path.join(output, taskId)) })))).sort((a, b) => a.task_id.localeCompare(b.task_id));
  const manifestBody = {
    schema_version: "1",
    kind: "gear-harbor-benchmark",
    benchmark: { id: "automationbench-public", revision: ref },
    adapter: { id: "automationbench-public-source", revision: adapterRevision, output_protocol: "gear-harbor-eval-result-v1" },
    scoring: {
      total_score: { source_metric: "task_completed_correctly", direction: "maximize", range: [0, 1], reducer: "task-macro-mean" },
      process_score: { source_metric: "partial_credit", direction: "maximize", range: [0, 1], reducer: "task-macro-mean" },
    },
    tasks: taskEntries,
  };
  await json(path.join(output, "benchmark.adapter.json"), { ...manifestBody, dataset_digest: `sha256:${createHash("sha256").update(canonicalJson(manifestBody)).digest("hex")}` });
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

async function treeDigest(root) {
  const rows = [];
  const visit = async directory => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const info = await stat(absolute);
        rows.push({ path: relative, mode: info.mode & 0o111 ? "executable" : "file", sha256: createHash("sha256").update(await readFile(absolute)).digest("hex") });
      } else throw new Error(`unsupported task entry: ${relative}`);
    }
  };
  await visit(root);
  return `sha256:${createHash("sha256").update(JSON.stringify(rows)).digest("hex")}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}

import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { executeRun, newRunId } from "../src/runs/index.js";
import { validateRunRequest } from "../src/runs/request.js";

test("isolated Codex executes through Hitch, denies private files and credentials, and confirms process termination", { skip: process.platform !== "darwin" && process.platform !== "linux" }, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "hitch-isolated-test-")));
  const candidate = path.join(root, "candidate"), output = path.join(root, "output");
  await mkdir(candidate); await mkdir(output);
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = path.join(root, "private.txt"), fake = path.join(root, "codex");
  await writeFile(secret, "private-source");
  const quote = (value: string) => "'" + value.split("'").join("'\"'\"'") + "'";
  // Use a system shell so the fixture has no Xcode/Homebrew interpreter closure.
  await writeFile(fake, `#!/bin/sh
set -eu
if [ "$1" = '--version' ]; then
  printf '%s\\n' 'codex-cli 0.145.0'
  exit 0
fi
prompt=$(cat)
if [ "\${OPENAI_API_KEY+x}\${CODEX_API_KEY+x}\${HITCH_CODEX_AUTH_HOME+x}" ]; then
  printf '%s\\n' 'private credentials reached the agent' >&2
  exit 41
fi
if cat ${quote(secret)} >/dev/null 2>&1; then
  printf '%s\\n' 'private file was readable' >&2
  exit 42
fi
${process.platform === "darwin" ? "/bin/zsh" : "/bin/sh"} -lc 'cat <<END
heredoc-ok
END'
if [ "$prompt" = 'hang' ]; then
  printf '%s' 'started' > ${quote(path.join(output, "started"))}
  sleep 60
fi
previous=''
for argument do
  if [ "$previous" = '--output-last-message' ]; then
    printf '%s' '{"isolated":true}' > "$argument"
  fi
  previous=$argument
done
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0,"cached_input_tokens":0}}'
`);
  await chmod(fake, 0o755);
  const oldPath = process.env.HITCH_CODEX_PATH, oldKey = process.env.OPENAI_API_KEY;
  process.env.HITCH_CODEX_PATH = fake; process.env.OPENAI_API_KEY = "test-private-key";
  t.after(() => {
    if (oldPath === undefined) delete process.env.HITCH_CODEX_PATH; else process.env.HITCH_CODEX_PATH = oldPath;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
  });
  const request = { harness_ref: "codex@installed", cwd: candidate, model: "test", prompt: "check", timeout_ms: 10000,
    workspace_mode: "shared", agent_args: [], generation_budget: { model_requests: 1, tokens: 1000 },
    isolation: { read_paths: [candidate, output], write_paths: [output], unix_sockets: [], allowed_domains: ["api.openai.com"], output_file: path.join(output, "result.json") } };
  const diagnostics: unknown[] = [];
  const first = await executeRun({ root, runsRoot: path.join(root, "runs"), runId: newRunId(), request,
    onEvent: event => { if (event.type === "process.stderr") diagnostics.push(event.text); } });
  assert.equal(first.status, "succeeded", JSON.stringify({ first, diagnostics }));
  assert.deepEqual(first.execution, { stopped: true });
  assert.equal((first.generation_usage as Record<string, unknown>).model_requests, 0);
  assert.deepEqual(JSON.parse(await readFile(path.join(output, "result.json"), "utf8")), { isolated: true });
  assert.equal(await readFile(secret, "utf8"), "private-source");
  const controller = new AbortController();
  const cancelling = executeRun({ root, runsRoot: path.join(root, "runs"), runId: newRunId(), request: { ...request, prompt: "hang" },
    signal: controller.signal });
  // Cancel the running model; interpreter startup timing is not a readiness signal.
  let started = false;
  for (let index = 0; index < 200 && !started; index++) {
    started = await readFile(path.join(output, "started")).then(() => true).catch(() => false);
    if (!started) await delay(25);
  }
  controller.abort();
  const cancelled = await cancelling;
  assert.ok(started, JSON.stringify(cancelled));
  assert.equal(cancelled.status, "cancelled", JSON.stringify(cancelled));
  assert.deepEqual(cancelled.execution, { stopped: true });
  await rm(path.join(output, "started"), { force: true });
  const requestFile = path.join(root, "cli-request.json");
  await writeFile(requestFile, JSON.stringify({ ...request, prompt: "hang" }));
  const cli = spawn(process.execPath, ["dist/bin/hitch.js", "--root", root, "run", "--request-file", requestFile, "--output", "json", "--watch-stdin"], { stdio: ["pipe", "pipe", "pipe"] });
  let reply = "", errors = "";
  cli.stdout.on("data", chunk => { reply += chunk.toString(); });
  cli.stderr.on("data", chunk => { errors += chunk.toString(); });
  const exited = new Promise<void>((resolve, reject) => { cli.once("error", reject); cli.once("close", () => resolve()); });
  for (let index = 0; index < 200; index++) {
    if (await readFile(path.join(output, "started")).then(() => true).catch(() => false)) break;
    await delay(25);
  }
  cli.stdin.end();
  await exited;
  assert.ok(reply, errors);
  assert.equal(JSON.parse(reply).status, "cancelled");
  assert.deepEqual(JSON.parse(reply).execution, { stopped: true });
  const changed = await executeRun({ root, runsRoot: path.join(root, "runs"), runId: newRunId(), request: { ...request, isolation: { ...request.isolation, executable_sha256: `sha256:${"0".repeat(64)}` } } });
  assert.equal(changed.status, "failed");
  assert.deepEqual(changed.execution, { stopped: true });
  assert.equal((changed.generation_usage as Record<string, unknown>).model_requests, 0);
  await assert.rejects(validateRunRequest({ ...request, isolation: undefined }), /isolated runs require/);
});

test("isolated installed npm Codex executes its native binary and checks that binary's digest", { skip: process.platform !== "darwin" && process.platform !== "linux" }, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "hitch-isolated-npm-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, "candidate"), output = path.join(root, "output");
  await mkdir(candidate); await mkdir(output);
  const packageRoot = path.join(root, "node_modules/@openai/codex"), launcher = path.join(packageRoot, "bin/codex.js");
  await mkdir(path.dirname(launcher), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.145.0", bin: { codex: "bin/codex.js" } }));
  // The ordinary host-side version probe may use Node. Execution must bypass
  // the launcher, even on hosts where Node is absent from /usr/bin and /bin.
  await writeFile(launcher, '#!/usr/bin/env node\nif (process.argv[2] === "--version") console.log("codex-cli 0.145.0"); else process.exit(87);\n', { mode: 0o755 });
  const target = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl"}`;
  const platform = `${process.platform}-${process.arch}`, dependency = path.join(packageRoot, "node_modules/@openai", `codex-${platform}`);
  const native = path.join(dependency, "vendor", target, "bin", "codex"), companion = path.join(path.dirname(native), "codex-code-mode-host");
  await mkdir(path.dirname(native), { recursive: true });
  await writeFile(path.join(dependency, "package.json"), JSON.stringify({ name: `@openai/codex-${platform}` }));
  await writeFile(companion, '#!/bin/sh\nprintf \'%s\' \'{"native":true}\'\n', { mode: 0o755 });
  const quote = (value: string) => "'" + value.split("'").join("'\"'\"'") + "'";
  await writeFile(native, `#!/bin/sh
set -eu
cat >/dev/null
if cat ${quote(launcher)} >/dev/null 2>&1; then
  printf '%s\\n' 'npm launcher was readable' >&2
  exit 88
fi
previous=''
for argument do
  if [ "$previous" = '--output-last-message' ]; then
    ${quote(companion)} > "$argument"
  fi
  previous=$argument
done
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0}}'
`, { mode: 0o755 });
  const oldPath = process.env.HITCH_CODEX_PATH, oldKey = process.env.OPENAI_API_KEY;
  process.env.HITCH_CODEX_PATH = launcher; process.env.OPENAI_API_KEY = "test-private-key";
  t.after(() => {
    if (oldPath === undefined) delete process.env.HITCH_CODEX_PATH; else process.env.HITCH_CODEX_PATH = oldPath;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
  });
  const { createHash } = await import("node:crypto");
  const digest = `sha256:${createHash("sha256").update(await readFile(native)).digest("hex")}`;
  const resultPath = path.join(output, "result.json");
  const request = { harness_ref: "codex@installed", cwd: candidate, model: "test", prompt: "check", timeout_ms: 10000,
    workspace_mode: "shared", agent_args: [], generation_budget: { model_requests: 1, tokens: 1000 },
    isolation: { read_paths: [candidate, output], write_paths: [output], unix_sockets: [], allowed_domains: ["api.openai.com"], output_file: resultPath, executable_sha256: digest } };
  const diagnostics: unknown[] = [];
  const result = await executeRun({ root, runsRoot: path.join(root, "runs"), runId: newRunId(), request,
    onEvent: event => { if (event.type === "process.stderr") diagnostics.push(event.text); } });
  assert.equal(result.status, "succeeded", JSON.stringify({ result, diagnostics }));
  assert.deepEqual(result.execution, { stopped: true });
  assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), { native: true });
  await rm(resultPath);
  // A matching unchanged launcher cannot conceal a changed native executable.
  await writeFile(native, (await readFile(native, "utf8")) + "\n# native changed after admission\n");
  const changed = await executeRun({ root, runsRoot: path.join(root, "runs"), runId: newRunId(), request });
  assert.equal(changed.status, "failed");
  assert.deepEqual(changed.execution, { stopped: true });
  assert.equal((changed.generation_usage as Record<string, unknown>).model_requests, 0);
  await assert.rejects(readFile(resultPath), { code: "ENOENT" });
});

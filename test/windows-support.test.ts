import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureControllerRuntime } from "../src/controller-runtime/index.js";
import { executeRun, newRunId } from "../src/runs/index.js";

test("Windows executes an installed agent batch shim through the complete run engine", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-windows-run-"));
  const implementation = path.join(root, "fake-codex.cjs");
  const shim = path.join(root, "fake-codex.cmd");
  const previous = process.env.HITCH_CODEX_PATH;
  t.after(async () => {
    if (previous === undefined) delete process.env.HITCH_CODEX_PATH;
    else process.env.HITCH_CODEX_PATH = previous;
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(implementation, `
if (process.argv.includes("--version")) { process.stdout.write("codex-cli 9.9.9\\n"); process.exit(0); }
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"thread_windows"}) + "\\n");
  process.stdout.write(JSON.stringify({type:"item.completed",item:{id:"item_1",type:"agent_message",text:"reply:" + prompt}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:2}}) + "\\n");
});
`.trimStart());
  await writeFile(shim, `@echo off\r\nnode "%~dp0fake-codex.cjs" %*\r\n`);
  process.env.HITCH_CODEX_PATH = shim;

  const runId = newRunId();
  const result = await executeRun({
    runId,
    request: { agent: "codex", model: "", cwd: root, prompt: "windows", timeout_ms: 5_000, agent_args: [] },
    runsRoot: path.join(root, "runs"),
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.output, "reply:windows");
  const events = (await readFile(path.join(root, "runs", runId, "events.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line) as { type: string; text?: string });
  assert.deepEqual(events.filter((event) => event.type.startsWith("message.")).map(({ type, text }) => ({ type, text })), [
    { type: "message.completed", text: "reply:windows" },
  ]);
});

test("Windows promotes and verifies the controller runtime without POSIX mode evidence", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-windows-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const runtime = await ensureControllerRuntime({ root });
  const entrypoint = runtime.manifest.files.find((file) => file.path === runtime.manifest.entrypoints.cli.path);
  assert.equal(entrypoint?.executable, true);
  assert.equal(runtime.cache_hit, false);
  assert.equal((await ensureControllerRuntime({ root })).cache_hit, true);
});

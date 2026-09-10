import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RemoteCanaryWorker, shellQuote } from "../scripts/canary-worker-host.js";
import { parseCanaryWorkerConfig } from "../scripts/canary-worker-peer.js";
import { runCommand } from "../src/foundation/index.js";

const config = { ssh_host: "worker-test", ssh_config: "/private/worker ssh.conf", runs_directory: "/opt/worker checks",
  node: "/opt/node/bin/node", hitch: "/opt/worker's hitch", python: "/opt/harbor/bin/python", docker: "/usr/bin/docker", remote_port: 32992 };

test("SSH diagnostic requires explicit host, absolute paths, and a bounded loopback port", () => {
  assert.deepEqual(parseCanaryWorkerConfig(config), config);
  for (const changed of [{ ssh_host: "-oProxyCommand=x" }, { ssh_host: "worker\nother" }, { hitch: "relative" },
    { runs_directory: "/" }, { node: "/opt/../bin/node" }, { python: "/opt/python\0other" },
    { remote_port: 0 }, { remote_port: 65536 }, { unexpected: true }]) {
    assert.throws(() => parseCanaryWorkerConfig({ ...config, ...changed }));
  }
});

test("SSH shell quoting preserves metacharacters as literal path bytes", async () => {
  for (const value of ["with spaces", "one'two", "$(printf injected)", "`printf injected`", "line\nnext", "中文路径"]) {
    const result = await runCommand("/bin/sh", ["-c", `printf '%s' ${shellQuote(value)}`], { timeoutMs: 5000 });
    assert.equal(result.stdout, value);
  }
});

test("worker credentials use stdin and reverse forwarding binds only loopback (SSH executable fixture)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hitch-ssh-argv-fixture-"));
  const originalPath = process.env.PATH;
  try {
    const executable = path.join(root, "bin"); await mkdir(executable);
    const capture = path.join(root, "capture.jsonl");
    await writeFile(path.join(executable, "ssh"), `#!${process.execPath}\n` +
      `const fs=require('node:fs');const input=fs.readFileSync(0,'utf8');fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({argv:process.argv.slice(2),input:JSON.parse(input)})+'\\n');console.log(JSON.stringify({prepared:true}));\n`, { mode: 0o700 });
    process.env.PATH = `${executable}:${originalPath ?? "/usr/bin:/bin"}`;
    const registration = path.join(root, "registration.json"), credential = path.join(root, "credential.json");
    await writeFile(registration, '{"worker_id":"fixture_worker"}');
    await writeFile(credential, '{"token":"credential-must-not-appear-in-command-line"}', { mode: 0o600 });
    const worker = new RemoteCanaryWorker(config, root, path.join(root, "worker"));
    const child = await worker.start(31022, registration, credential);
    assert.equal((await once(child, "close"))[0], 0);
    const rows = (await readFile(capture, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].input.operation, "prepare");
    assert.equal(rows[0].input.credential.token, "credential-must-not-appear-in-command-line");
    assert.equal(rows[1].input.operation, "run");
    assert.equal(rows[1].input.credential, undefined);
    assert.ok(rows[1].argv.includes("127.0.0.1:32992:127.0.0.1:31022"));
    for (const row of rows) {
      assert.ok(!JSON.stringify(row.argv).includes("credential-must-not-appear-in-command-line"));
      assert.equal(row.argv.at(-1), `${shellQuote(config.node)} ${shellQuote(`${config.hitch}/dist/scripts/canary-worker-peer.js`)}`);
    }
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});

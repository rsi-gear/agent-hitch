import { readFile } from "node:fs/promises";
import { DaemonServer } from "../src/daemon/index.js";
import { runEval } from "../src/evals/index.js";
import { prepareHostHarborArtifactForTest } from "./helpers.js";

// Separate OS process: the test kills this daemon without running any shutdown
// hook, then starts this same entry point over the untouched durable state.
const config = JSON.parse(await readFile(process.argv[2]!, "utf8")) as { root: string; port: number; harbor: string };
const server = new DaemonServer({ root: config.root, port: config.port, maxConcurrent: 1,
  resourceCapacity: { cpu_millis: 1_000, memory_bytes: 1024 ** 3, container_slots: 1, build_slots: 1 },
  evalExecutor: options => runEval({ ...options, harborExecutable: config.harbor, env: process.env, harborArtifactBuilder: prepareHostHarborArtifactForTest }),
  logger: (type, fields) => { if (type !== "worker.heartbeat") process.stdout.write(`${JSON.stringify({ type, ...fields })}\n`); },
});
await server.start();
process.once("SIGTERM", () => { void server.close(); });
await server.closed;

import path from "node:path";
import {
  loadRemoteWorkerCredential,
  loadRemoteWorkerRegistration,
  loadRemoteWorkerToken,
  RemoteWorkerHttpClient,
  RemoteWorkerRunner,
  writeRemoteWorkerCredential,
} from "../../control-plane/index.js";
import { releaseRemoteHarborOffer, remoteHarborWorker } from "../../workers/index.js";
import { invalidInput, parseDuration } from "../../foundation/index.js";
import { assertNoArgs, takeFlag, takeOption } from "../arguments.js";

export async function workerCommand(args: string[], root: string): Promise<void> {
  const action = args.shift();
  if (action === "register") return registerWorker(args);
  if (action === "run") return runWorker(args, root);
  throw invalidInput("worker requires register or run");
}

async function registerWorker(args: string[]): Promise<void> {
  const server = requiredOption(args, "--server");
  const registrationFile = path.resolve(requiredOption(args, "--registration"));
  const adminTokenFile = path.resolve(requiredOption(args, "--admin-token-file"));
  const credentialFile = path.resolve(requiredOption(args, "--credential-file"));
  assertNoArgs(args);
  const registration = await loadRemoteWorkerRegistration(registrationFile);
  const adminToken = await loadRemoteWorkerToken(adminTokenFile);
  const credential = await RemoteWorkerHttpClient.register({ baseUrl: server, adminToken, registration });
  await writeRemoteWorkerCredential(credentialFile, credential);
  process.stdout.write(`Registered ${credential.worker_id} generation ${credential.generation}; credential written to ${credentialFile}\n`);
}

async function runWorker(args: string[], root: string): Promise<void> {
  const server = requiredOption(args, "--server");
  const registrationFile = path.resolve(requiredOption(args, "--registration"));
  const credentialFile = path.resolve(requiredOption(args, "--credential-file"));
  const harborExecutable = takeOption(args, "--harbor");
  const dockerExecutable = takeOption(args, "--docker");
  const once = takeFlag(args, "--once");
  const pollIntervalMs = durationOption(args, "--poll-interval", 1_000);
  const heartbeatIntervalMs = durationOption(args, "--heartbeat-interval", 10_000);
  assertNoArgs(args);
  const registration = await loadRemoteWorkerRegistration(registrationFile);
  const credential = await loadRemoteWorkerCredential(credentialFile);
  if (registration.worker_id !== credential.worker_id) throw invalidInput("worker registration and credential identities do not match");
  const client = new RemoteWorkerHttpClient({ baseUrl: server, credential });
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("worker shutdown requested"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const execution = {
    root,
    ...(harborExecutable ? { harborExecutable: path.resolve(harborExecutable) } : {}),
    ...(dockerExecutable ? { dockerExecutable: path.resolve(dockerExecutable) } : {}),
  };
  const runner = new RemoteWorkerRunner({
    client, capacity: registration.capacity.allocatable, execute: remoteHarborWorker(execution),
    releaseUnknown: (offer) => releaseRemoteHarborOffer(execution, offer),
    signal: controller.signal, once, pollIntervalMs, heartbeatIntervalMs,
    onError: (error) => process.stderr.write(`hitch worker: ${safeMessage(error)}\n`),
  });
  process.stdout.write(`Running ${credential.worker_id} generation ${credential.generation}\n`);
  try { await runner.run(); }
  finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

function requiredOption(args: string[], name: string): string {
  const value = takeOption(args, name);
  if (!value) throw invalidInput(`${name} is required`);
  return value;
}

function durationOption(args: string[], name: string, fallback: number): number {
  const value = takeOption(args, name);
  const parsed = value === undefined ? fallback : parseDuration(value);
  if (!Number.isSafeInteger(parsed) || parsed < 50 || parsed > 5 * 60_000) throw invalidInput(`${name} must be between 50ms and 5m`);
  return parsed;
}

function safeMessage(error: unknown): string { return ((error as Error)?.message || String(error)).replace(/[\0\r\n]/g, " ").slice(0, 1_024); }

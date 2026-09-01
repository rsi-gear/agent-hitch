import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RemoteWorkerRegistrationV1 } from "../domain/index.js";
import { atomicWriteJSON, invalidInput } from "../foundation/index.js";
import { parseRemoteWorkerCredential } from "./remote-worker-client.js";
import type { RemoteWorkerCredentialV1 } from "./remote-worker-client.js";
import { parseRemoteWorkerRegistration } from "./remote-workers.js";

export async function loadRemoteWorkerRegistration(file: string): Promise<RemoteWorkerRegistrationV1> {
  return parseRemoteWorkerRegistration(await jsonFile(file, "worker registration"));
}

export async function loadRemoteWorkerCredential(file: string): Promise<RemoteWorkerCredentialV1> {
  return parseRemoteWorkerCredential(await jsonFile(file, "worker credential"));
}

export async function loadRemoteWorkerToken(file: string): Promise<string> {
  try { return (await readFile(path.resolve(file), "utf8")).trim(); }
  catch (error) { throw invalidInput(`worker admin credential is not readable: ${safeMessage(error)}`); }
}

export function writeRemoteWorkerCredential(file: string, credential: RemoteWorkerCredentialV1): Promise<void> {
  return atomicWriteJSON(path.resolve(file), parseRemoteWorkerCredential(credential), 0o600);
}

async function jsonFile(file: string, label: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path.resolve(file), "utf8")) as unknown; }
  catch (error) { throw invalidInput(`${label} is not readable JSON: ${safeMessage(error)}`); }
}

function safeMessage(error: unknown): string {
  return ((error as Error)?.message || String(error)).replace(/[\0\r\n]/g, " ").slice(0, 1_024);
}

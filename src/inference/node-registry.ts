import path from "node:path";
import type { InferenceRuntimeManifestV1, ModelNodeBindingV2, Sha256 } from "../domain/index.js";
import { HitchError, atomicWriteJSON, readJSON, sha256JSON, statePaths, withFileLock } from "../foundation/index.js";
import { parseInferenceRuntimeManifest, parseModelNodeBinding } from "./manifest.js";
import { PythonInferenceNodeClient } from "./node-client.js";
import type { InferenceNodeConnection } from "./node-client.js";

export interface ModelNodeRegistrationV2 {
  schema_version: "2";
  binding: ModelNodeBindingV2;
  connection: InferenceNodeConnection;
}
export interface ModelNodeObservationV2 {
  nodeId: string; generation: string; runtimeDigest: Sha256;
  runtime: { pythonVersion: string; packagesDigest: Sha256; packages: Array<{ name: string; version: string; commit: string | null }> };
  gpuUuids: string[]; launchers: string[];
  capabilities: { binaryCas: boolean; durableInferenceProcesses: boolean };
}

export function parseModelNodeRegistration(value: unknown): ModelNodeRegistrationV2 {
  const record = exact(value, ["schema_version", "binding", "connection"]);
  if (record.schema_version !== "2") throw new TypeError("model node registration requires schema version 2");
  const binding = parseModelNodeBinding(record.binding);
  const connection = exact(record.connection, ["transport", "python", "configPath", "gateway"]);
  const transport = exact(connection.transport, ["type", "host"]);
  if (transport.type !== "local" && transport.type !== "ssh" || transport.type === "local" && transport.host !== undefined) throw new TypeError("invalid model node transport");
  const gateway = exact(connection.gateway, ["localPort", "nodePort"]);
  if (!Array.isArray(connection.python) || typeof connection.configPath !== "string") throw new TypeError("invalid model node connection");
  const result = { schema_version: "2", binding, connection: { transport, python: connection.python, configPath: connection.configPath, gateway } } as ModelNodeRegistrationV2;
  // Shared command/port/SSH validation, without launching a process.
  new PythonInferenceNodeClient(result.connection, { nodeId: binding.node_id, generation: binding.generation });
  if (transport.type === "local" && gateway.localPort !== gateway.nodePort) throw new TypeError("local model node route ports must match");
  return result;
}

export async function observeModelNode(client: PythonInferenceNodeClient, binding: ModelNodeBindingV2): Promise<ModelNodeObservationV2> {
  const value = await client.call("probe", {}) as ModelNodeObservationV2;
  if (!value || value.nodeId !== binding.node_id || value.generation !== binding.generation
    || value.runtimeDigest !== binding.runtime_digest || sha256JSON(value.runtime) !== binding.runtime_digest
    || !Array.isArray(value.gpuUuids) || value.gpuUuids.some(uuid => typeof uuid !== "string")
    || !Array.isArray(value.launchers) || !value.launchers.includes("process")
    || value.capabilities?.binaryCas !== true || value.capabilities?.durableInferenceProcesses !== true) {
    throw new HitchError("model-node generation, Python runtime or process capability changed", { code: "inference_runtime_mismatch", exitCode: 12 });
  }
  return value;
}

export function runtimeFromModelNode(observation: ModelNodeObservationV2): InferenceRuntimeManifestV1 {
  const packages = observation.runtime.packages.filter(item => item.name === "sglang");
  if (packages.length !== 1) throw new TypeError("model node must observe exactly one SGLang distribution");
  const packageInfo = packages[0]!;
  const body = { schema_version: "2" as const, engine: "sglang" as const, sglang_version: packageInfo.version, sglang_commit: packageInfo.commit,
    backend: "cuda" as const, package: { kind: "python-env" as const, environment_digest: observation.runtimeDigest,
      python_version: observation.runtime.pythonVersion, packages_digest: observation.runtime.packagesDigest }, compatibility_profile: "gear-model-node-v2" };
  return parseInferenceRuntimeManifest({ ...body, runtime_id: sha256JSON(body) });
}

export async function registerModelNode(root: string, value: unknown, env: NodeJS.ProcessEnv = process.env) {
  const registration = parseModelNodeRegistration(value);
  const { binding, connection } = registration;
  const client = new PythonInferenceNodeClient(connection, { nodeId: binding.node_id, generation: binding.generation }, env);
  const observation = await observeModelNode(client, binding);
  const runtime = runtimeFromModelNode(observation);
  await withFileLock(statePaths(root).inferenceOperationLocks, sha256JSON(binding), async () => {
    // Explicit re-registration may repair connection coordinates after probing
    // the same frozen identity. Old generation records remain recoverable.
    await atomicWriteJSON(registrationPath(root, binding), registration);
    await atomicWriteJSON(path.join(statePaths(root).inferenceRuntimes, runtime.runtime_id.slice(7), "manifest.json"), runtime);
  });
  return { schema_version: "2", binding, runtime, gpu_uuids: observation.gpuUuids };
}

export async function loadModelNodeClient(root: string, binding: ModelNodeBindingV2, env: NodeJS.ProcessEnv = process.env) {
  const record = parseModelNodeRegistration(await readJSON(registrationPath(root, parseModelNodeBinding(binding))));
  if (sha256JSON(record.binding) !== sha256JSON(binding)) throw new TypeError("model node registration identity changed");
  return new PythonInferenceNodeClient(record.connection, { nodeId: binding.node_id, generation: binding.generation }, env);
}

function registrationPath(root: string, binding: ModelNodeBindingV2): string {
  return path.join(statePaths(root).inferenceNodes, sha256JSON(binding).slice(7) + ".json");
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new TypeError("invalid model node registration fields");
  return value as Record<string, unknown>;
}

export async function readModelNodeRegistration(file: string): Promise<ModelNodeRegistrationV2> {
  return parseModelNodeRegistration(await readJSON(file));
}
export async function readModelNodeBinding(file: string): Promise<ModelNodeBindingV2> {
  return parseModelNodeBinding(await readJSON(file));
}

import { verifyCapabilityBindings } from "./bindings.js";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { openContainedRegularFile } from "../foundation/index.js";
import { admitParameters, type AdmissionOptions, type ParameterState } from "./authority.js";
import { validateParameterContract } from "./contract.js";
import { bindParameterInputIdentities } from "./input-identities.js";
import { exact, parseParameterJSON, record, type JSONObject } from "./schema.js";

export async function readParameterJSON(directory: string, relative: string): Promise<unknown | undefined> {
  try {
    const safe = await openContainedRegularFile(await realpath(directory), relative, 1024 * 1024);
    try { const value = parseParameterJSON((await safe.handle.readFile()).toString("utf8")); await safe.assertUnchanged(); return value; }
    finally { await safe.handle.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
/** Both the package and the candidate values come from host-side sealed inputs. */
export async function admitTaskParameters(taskDirectory: string, options: { harnessDirectory?: string; identity?: AdmissionOptions["identity"] } = {}): Promise<ParameterState | undefined> {
  const contract = await readParameterJSON(taskDirectory, "parameters.json");
  if (contract === undefined) return undefined;
  const bindings = await readParameterJSON(taskDirectory, "parameter-overrides.json");
  let user: JSONObject | undefined, policy: AdmissionOptions["policy"];
  if (bindings !== undefined) {
    const r = record(bindings, "parameter overrides"); exact(r, ["version", "parameters", "parameter_policy"], "parameter overrides");
    if (r.version !== 1) throw new Error("unsupported parameter overrides version");
    user = r.parameters === undefined ? undefined : record(r.parameters, "user parameters") as JSONObject; policy = r.parameter_policy === undefined ? undefined : record(r.parameter_policy, "user parameter policy") as AdmissionOptions["policy"];
  }
  let meta: JSONObject | undefined;
  const parsed = validateParameterContract(contract);
  const candidates = [];
  if (parsed.candidate_parameters) candidates.push(await readParameterJSON(taskDirectory, parsed.candidate_parameters));
  if (options.harnessDirectory) candidates.push(await readParameterJSON(options.harnessDirectory, "source/task-parameters.json"));
  for (const candidate of candidates) if (candidate !== undefined) {
    const r = record(candidate, "candidate task parameters"); exact(r, ["version", "tasks"], "candidate task parameters");
    if (r.version !== 1) throw new Error("unsupported candidate parameters version");
    const values = record(r.tasks, "candidate tasks")[String(options.identity?.task_id ?? path.basename(taskDirectory))] as JSONObject | undefined;
    if (values !== undefined) {
      if (meta !== undefined) throw new Error("conflicting candidate parameter sources");
      meta = record(values, "candidate parameters") as JSONObject;
    }
  }
  const identity = await bindParameterInputIdentities(taskDirectory, parsed, options.identity);
  return admitParameters(contract, { bindings: await verifyCapabilityBindings(parsed, taskDirectory), ...(user !== undefined ? { user } : {}), ...(meta !== undefined ? { meta } : {}), ...(policy !== undefined ? { policy } : {}), identity });
}

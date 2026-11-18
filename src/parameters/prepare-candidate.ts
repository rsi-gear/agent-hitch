import { chmod, lstat, mkdir, rename, rm, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { durableWriteJSON, openContainedRegularFile } from "../foundation/index.js";
import { readParameterJSON } from "./files.js";
import { validateParameterContract, type ParameterContract } from "./contract.js";

/** Preserve author-owned inputs before any descriptor/runtime transformation. */
export async function preserveParameterEvaluationInputs(taskDirectory: string, copy?: (destination: string, bytes: Buffer, executable: boolean) => Promise<void>): Promise<ParameterContract | undefined> {
  const raw = await readParameterJSON(taskDirectory, "parameters.json");
  if (raw === undefined) return undefined;
  const contract = validateParameterContract(raw), root = await realpath(taskDirectory);
  const next = structuredClone(contract);
  const prefix = "gear-evaluation/";
  if (contract.evaluation_inputs && !contract.evaluation_input_origins) {
    const target = path.join(root, prefix), staging = path.join(root, `.parameter-inputs-${randomUUID()}`);
    if (await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; })) throw new TypeError("reserved evaluation input directory already exists");
    await mkdir(staging, { mode: 0o700 });
    try {
      const origins: Record<string, string> = {}; let bytes = 0;
      for (const relative of contract.evaluation_inputs) {
        if (relative.startsWith(prefix)) throw new TypeError("reserved evaluation input path cannot be an original input");
        const safe = await openContainedRegularFile(root, relative, 16 * 1024 * 1024);
        try {
          bytes += safe.size; if (bytes > 64 * 1024 * 1024) throw new TypeError("parameter identity input byte limit exceeded");
          const content = await safe.handle.readFile(), info = await safe.handle.stat(); await safe.assertUnchanged();
          const destination = path.join(staging, relative); await mkdir(path.dirname(destination), { recursive: true });
          if (copy) await copy(destination, content, Boolean(info.mode & 0o111));
          else { await writeFile(destination, content, { flag: "wx" }); await chmod(destination, info.mode & 0o777); }
          origins[prefix + relative] = relative;
        } finally { await safe.handle.close(); }
      }
      next.evaluation_inputs = contract.evaluation_inputs.map(relative => prefix + relative);
      next.evaluation_input_origins = origins;
      validateParameterContract(next);
      await rename(staging, target);
    } finally { await rm(staging, { force: true, recursive: true }); }
  } else if (contract.evaluation_input_origins) {
    // Repeated compilation preserves the same sealed original view. Missing or
    // linked copies fail before any candidate overlay is written.
    for (const relative of contract.evaluation_inputs!) {
      const safe = await openContainedRegularFile(root, relative, 16 * 1024 * 1024); await safe.handle.close();
    }
  }
  await durableWriteJSON(path.join(root, "parameters.json"), next);
  return next;
}

/** Bind the candidate's actual sealed files without changing policy or defaults. */
export async function prepareParameterCandidateInputs(taskDirectory: string, candidateInputPath: string): Promise<ParameterContract | undefined> {
  const raw = await readParameterJSON(taskDirectory, "parameters.json");
  if (raw === undefined) return undefined;
  const original = validateParameterContract(raw);
  const candidateInputs = [...new Set([...(original.candidate_inputs ?? []), candidateInputPath])];
  validateParameterContract({ ...original, candidate_inputs: candidateInputs });
  const contract = (await preserveParameterEvaluationInputs(taskDirectory))!;
  const next = validateParameterContract({ ...contract, candidate_inputs: candidateInputs });
  await durableWriteJSON(path.join(await realpath(taskDirectory), "parameters.json"), next);
  return next;
}

import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { openContainedRegularFile, sha256JSON } from "../foundation/index.js";
import type { ParameterContract } from "./contract.js";
import type { JSONValue } from "./schema.js";

/** Hash the original declared inputs, not a candidate's compiled dataset wrapper. */
export async function bindParameterInputIdentities(directory: string, contract: ParameterContract, supplied: Record<string, JSONValue> = {}): Promise<Record<string, JSONValue>> {
  const root = await realpath(directory), identity = structuredClone(supplied);
  const readInputs = async (inputs: string[], allowDirectories: boolean): Promise<JSONValue[]> => {
    const rows: JSONValue[] = [], visited = new Set<string>(); let bytes = 0;
    const visit = async (relative: string): Promise<void> => {
      if (visited.has(relative)) throw new TypeError("overlapping parameter identity inputs");
      visited.add(relative);
      if (visited.size > 8192) throw new TypeError("parameter identity input count limit exceeded");
      // Check every ancestor before directory enumeration. File reads additionally
      // pin inode identity and refuse symlinks/hardlinks throughout the read.
      let current = root;
      for (const segment of relative.split("/")) {
        current = path.join(current, segment);
        if ((await lstat(current)).isSymbolicLink()) throw new TypeError("parameter identity input contains a symlink");
      }
      const target = path.join(root, relative), before = await lstat(target);
      if (before.isDirectory()) {
        if (!allowDirectories) throw new TypeError("evaluation_inputs must name regular files");
        rows.push({ path: relative, kind: "directory" });
        for (const name of (await readdir(target)).sort()) await visit(`${relative}/${name}`);
        const after = await lstat(target);
        if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs) throw new TypeError("parameter identity directory changed while reading");
        return;
      }
      const safe = await openContainedRegularFile(root, relative, 16 * 1024 * 1024);
      try {
        bytes += safe.size;
        if (bytes > 64 * 1024 * 1024) throw new TypeError("parameter identity input byte limit exceeded");
        const content = await safe.handle.readFile(), stats = await safe.handle.stat();
        await safe.assertUnchanged();
        rows.push({ path: relative, kind: "file", bytes: content.length, executable: (stats.mode & 0o111) !== 0,
          digest: `sha256:${createHash("sha256").update(content).digest("hex")}` });
      } finally { await safe.handle.close(); }
    };
    for (const relative of [...inputs].sort()) await visit(relative);
    return rows;
  };
  if (contract.evaluation_inputs) {
    const inputs = (await readInputs(contract.evaluation_inputs, false)).map(row => {
      const entry = row as Record<string, JSONValue>;
      return { ...entry, path: contract.evaluation_input_origins?.[String(entry.path)] ?? entry.path! };
    }).sort((a, b) => Buffer.compare(Buffer.from(String(a.path)), Buffer.from(String(b.path))));
    identity.evaluation_inputs = inputs;
    identity.task = sha256JSON({ protocol: "hitch-parameter-evaluation-inputs@1", task_id: identity.task_id ?? path.basename(root), inputs });
  }
  if (contract.candidate_inputs) identity.candidate_inputs = sha256JSON({ protocol: "hitch-parameter-candidate-inputs@1", inputs: await readInputs(contract.candidate_inputs, true) });
  return identity;
}

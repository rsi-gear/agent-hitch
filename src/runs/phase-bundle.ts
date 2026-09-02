import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateEvalRunParent, validateRunContext } from "../domain/index.js";
import type { ResultBundleIndexV1 } from "../domain/index.js";
import { readJSON } from "../foundation/index.js";
import { verifyResultBundleIndex } from "./bundle.js";

/** Copy an already sealed phase verbatim. Never grade, repair, reseal or overwrite. */
export async function copySealedPhaseRunBundle(input: {
  sourceDirectory: string;
  destinationDirectory: string;
  expected: { run_id: string; context: unknown; parent: unknown };
}): Promise<ResultBundleIndexV1> {
  const context = validateRunContext(input.expected.context);
  const parent = validateEvalRunParent(input.expected.parent);
  if (context.kind !== "benchmark_phase" || !/^run_[a-f0-9]{32}$/.test(input.expected.run_id)) {
    throw new TypeError("sealed phase export requires an assigned phase identity");
  }
  if (!(await lstat(input.sourceDirectory)).isDirectory()) throw new TypeError("phase source must be a real directory");
  const source = await realpath(input.sourceDirectory);
  const requestedDestination = path.resolve(input.destinationDirectory);
  const destination = path.join(await realpath(path.dirname(requestedDestination)), path.basename(requestedDestination));
  if (source === destination || destination.startsWith(source + path.sep) || source.startsWith(destination + path.sep)) {
    throw new TypeError("phase source and destination must be disjoint");
  }
  const originalBytes = await readFile(path.join(source, "bundle.index.json"));
  const original = await verifyResultBundleIndex(source);
  const manifest = await readJSON<Record<string, unknown>>(path.join(source, "manifest.json"));
  const request = await readJSON<Record<string, unknown>>(path.join(source, "request.json"));
  const result = await readJSON<Record<string, unknown>>(path.join(source, "result.json"));
  if (original.run_id !== input.expected.run_id || result.run_id !== input.expected.run_id
    || !isDeepStrictEqual(manifest.context, context) || !isDeepStrictEqual(request.context, context)
    || !isDeepStrictEqual(manifest.parent, parent) || !isDeepStrictEqual(request.parent, parent)
    || manifest.observation !== undefined) {
    throw new TypeError("sealed phase bundle does not match its prepared identity");
  }
  // mkdir without recursive is the no-overwrite gate. Failed copies remain for
  // diagnosis; the caller must never publish them as a completed phase export.
  await mkdir(destination, { mode: 0o700 });
  for (const relative of [...original.files.map(file => file.path), "bundle.index.json"]) {
    const target = path.join(destination, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(path.join(source, ...relative.split("/")), target, constants.COPYFILE_EXCL);
  }
  const copied = await verifyResultBundleIndex(destination);
  const sourceAfter = await verifyResultBundleIndex(source);
  if (!isDeepStrictEqual(copied, original) || !isDeepStrictEqual(sourceAfter, original)
    || !originalBytes.equals(await readFile(path.join(destination, "bundle.index.json")))
    || !originalBytes.equals(await readFile(path.join(source, "bundle.index.json")))) {
    throw new TypeError("sealed phase bundle changed during transfer");
  }
  return copied;
}

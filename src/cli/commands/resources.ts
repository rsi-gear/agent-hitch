import { resourceFileRequest, resourceRequest } from "../../resources/index.js";
import { assertNoArgs, takeOption } from "../arguments.js";
import { exportResourceLegacy } from "../../evals/index.js";

export async function resourcesCommand(args: string[], root: string): Promise<void> {
  const action = args.shift();
  if (action === "legacy-export") {
    const ref = takeOption(args, "--ref"), output = takeOption(args, "--output"); assertNoArgs(args);
    if (!ref || !output) throw new TypeError("legacy-export requires --ref and --output");
    process.stdout.write(`${JSON.stringify(await exportResourceLegacy(root, ref, output))}\n`); return;
  }
  if (action !== "request") throw new TypeError("usage: hitch resources request OPERATION [--input JSON_FILE] --root DIRECTORY");
  const operation = args.shift(), file = takeOption(args, "--input"); assertNoArgs(args);
  if (!operation) throw new TypeError("resource API operation is required");
  const value = file ? await resourceFileRequest(root, operation, file) : await resourceRequest(root, operation, {});
  process.stdout.write(`${JSON.stringify(value ?? null)}\n`);
}

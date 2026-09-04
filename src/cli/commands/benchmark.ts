import { lockBenchmark, validateBenchmark } from "../../benchmarks/index.js";
import { invalidInput } from "../../foundation/index.js";
import { assertNoArgs, takeOption } from "../arguments.js";

export async function benchmarkCommand(args: string[]): Promise<void> {
  const action = args.shift();
  const directory = takeOption(args, "--package");
  if (!directory) throw invalidInput("benchmark requires --package");
  const output = takeOption(args, "--out");
  assertNoArgs(args);
  if (action !== "lock" && output) throw invalidInput("--out requires benchmark lock");
  const result = action === "validate" ? await validateBenchmark(directory)
    : action === "lock" ? await lockBenchmark(directory, output)
    : (() => { throw invalidInput("benchmark requires validate or lock"); })();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

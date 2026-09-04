#!/usr/bin/env node

import { main } from "../src/cli/index.js";
import { SCHEMA_VERSION } from "../src/foundation/index.js";

const argv = process.argv.slice(2);

main(argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const exitCode = (error as { exitCode?: unknown }).exitCode;
  const normalizedExitCode = Number.isInteger(exitCode) ? exitCode as number : 12;
  if (requestsJson(argv)) {
    const rawCode = (error as { code?: unknown }).code;
    process.stderr.write(`${JSON.stringify({
      schema_version: SCHEMA_VERSION,
      kind: "error",
      error: {
        code: typeof rawCode === "string" ? rawCode : "internal_error",
        message,
        exit_code: normalizedExitCode,
      },
    })}\n`);
  } else {
    process.stderr.write(`hitch: ${message}\n`);
  }
  process.exitCode = normalizedExitCode;
});

function requestsJson(args: readonly string[]): boolean {
  if (args.includes("--json")) return true;
  return args.some((value, index) => value === "--output" && args[index + 1] === "json");
}

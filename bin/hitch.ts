#!/usr/bin/env node

import { main } from "../src/cli.js";

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`hitch: ${message}\n`);
  const exitCode = (error as { exitCode?: unknown }).exitCode;
  process.exitCode = Number.isInteger(exitCode) ? exitCode as number : 12;
});

#!/usr/bin/env node

import { main } from "../src/cli.js";

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`hitch: ${message}\n`);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 12;
});

import { discoverAgents } from "../../adapters/index.js";
import { SCHEMA_VERSION } from "../../foundation/index.js";
import { assertNoArgs, takeFlag } from "../arguments.js";

export async function listCommand(args: string[]): Promise<void> {
  const json = takeFlag(args, "--json");
  assertNoArgs(args);
  const agents = await discoverAgents();
  if (json) {
    process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, harnesses: agents }, null, 2)}\n`);
    return;
  }
  for (const agent of agents) {
    const detail = agent.status === "available" ? `${agent.version || "version unknown"}  ${agent.executable}` : "not installed";
    process.stdout.write(`${agent.id.padEnd(10)} ${agent.status.padEnd(11)} ${detail}\n`);
  }
}

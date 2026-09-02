// Generic tool-server@1 CLI transport. All tool names and schemas are package data.
import { readFile } from "node:fs/promises";
const binding = JSON.parse(await readFile("/tmp/hitch-tool-binding.json", "utf8"));
const [name, argument = "{}"] = process.argv.slice(2);
if (!name || name === "list") {
  process.stdout.write(`${JSON.stringify(binding.tools, null, 2)}\n`);
} else {
  if (!binding.tools.some((tool) => tool.name === name)) throw new Error("Unknown tool name; use list");
  const args = argument === "-" ? JSON.parse(await readFile(0, "utf8")) : JSON.parse(argument);
  const response = await fetch(new URL("call", binding.endpoint), {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${binding.token}` },
    body: JSON.stringify({ name, arguments: args }), signal: AbortSignal.timeout(60000),
  });
  const result = await response.text();
  if (!response.ok) throw new Error(`Tool transport ${response.status}: ${result}`);
  process.stdout.write(`${result}\n`);
}

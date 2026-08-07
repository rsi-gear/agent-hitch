import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeFakeCodex(directory, { delayMs = 0, exitCode = 0, splitReply = false } = {}) {
  const file = path.join(directory, "fake-codex");
  const source = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 9.9.9\\n");
  process.exit(0);
}
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  setTimeout(() => {
    process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"thread_fake"}) + "\\n");
    ${splitReply
      ? 'process.stdout.write(JSON.stringify({type:"item.completed",item:{id:"item_1",type:"agent_message",text:"reply:"}}) + "\\n");\n    process.stdout.write(JSON.stringify({type:"item.completed",item:{id:"item_2",type:"agent_message",text:prompt}}) + "\\n");'
      : 'process.stdout.write(JSON.stringify({type:"item.completed",item:{id:"item_1",type:"agent_message",text:"reply:" + prompt}}) + "\\n");'}
    process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:2}}) + "\\n");
    process.exit(${exitCode});
  }, ${delayMs});
});
`;
  await writeFile(file, source, { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}

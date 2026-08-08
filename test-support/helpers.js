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

export async function writeFakePi(directory) {
  const file = path.join(directory, "fake-pi");
  const source = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("pi 0.82.1\\n");
  process.exit(0);
}
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const usage = {input:1,output:2,cacheRead:0,cacheWrite:0,totalTokens:3,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
  process.stdout.write(JSON.stringify({type:"session",version:3,id:"pi_session",cwd:process.cwd()}) + "\\n");
  process.stdout.write(JSON.stringify({type:"message_update",assistantMessageEvent:{type:"text_delta",contentIndex:0,delta:"reply:"}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"message_update",assistantMessageEvent:{type:"text_delta",contentIndex:0,delta:prompt}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"reply:" + prompt}],usage,stopReason:"stop"}}) + "\\n");
});
`;
  await writeFile(file, source, { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}

export async function writeFakeOpenCode(directory) {
  const file = path.join(directory, "fake-opencode");
  const source = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("opencode 1.18.15\\n");
  process.exit(0);
}
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const base = {timestamp:Date.now(),sessionID:"oc_session"};
  process.stdout.write(JSON.stringify({...base,type:"step_start",part:{id:"part_start",sessionID:base.sessionID,messageID:"message_1",type:"step-start"}}) + "\\n");
  process.stdout.write(JSON.stringify({...base,type:"text",part:{id:"part_text",sessionID:base.sessionID,messageID:"message_1",type:"text",text:"reply:" + prompt,time:{start:1,end:2}}}) + "\\n");
  process.stdout.write(JSON.stringify({...base,type:"step_finish",part:{id:"part_finish",sessionID:base.sessionID,messageID:"message_1",type:"step-finish",reason:"stop",cost:0,tokens:{input:1,output:2,reasoning:0,cache:{read:0,write:0}}}}) + "\\n");
});
`;
  await writeFile(file, source, { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}

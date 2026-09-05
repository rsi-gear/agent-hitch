import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeBenchmarkFixture } from "./benchmark-fixture.js";

/** Real harness transport canary only; never an OSWorld task or score. */
export async function writeDesktopBenchmarkFixture(directory: string): Promise<void> {
  await writeBenchmarkFixture(directory, { benchmark: "hitch-desktop-contract", task: "click-blue", tool: "observe", metric: "target_clicked" });
  const task = path.join(directory, "tasks/click-blue");
  for (const [filename, field] of [[path.join(task, "task.hitch.json"), "requirements"], [path.join(directory, "profiles/default.json"), "allowed"]]) {
    const value = JSON.parse(await readFile(filename!, "utf8"));
    (field === "requirements" ? value.requirements : value.tool_policy.allowed).push("native-image-input", "tool-result-images@1");
    await writeFile(filename!, JSON.stringify(value, null, 2));
  }
  const tools = [
    { name: "observe", description: "Observe the current 320 by 180 pixel desktop. Open the returned image with your image viewing tool.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "click", description: "Click one pixel at x,y using the latest observation sequence. There is exactly one click available.", inputSchema: { type: "object", properties: { seq: { type: "integer" }, x: { type: "integer", minimum: 0, maximum: 319 }, y: { type: "integer", minimum: 0, maximum: 179 } }, required: ["seq", "x", "y"], additionalProperties: false } },
  ];
  for (const folder of [path.join(directory, "runtime"), path.join(task, "environment")]) {
    await writeFile(path.join(folder, "tools.json"), JSON.stringify(tools));
    await copyFile(path.resolve("test-support/fixtures/desktop-service.py"), path.join(folder, "service.py"));
  }
  await writeFile(path.join(task, "instruction.md"), "Observe the desktop and click inside the blue rectangle. You have only one click. Inspect the native image before clicking.\n");
  const config = path.join(task, "task.toml");
  await writeFile(config, (await readFile(config, "utf8")).replace("timeout_sec = 60", "timeout_sec = 300").replace('artifacts = [{source = "/evidence/counter.json", service = "counter"}]', 'artifacts = [{source = "/evidence/counter.json", service = "counter"}, {source = "/evidence/screen.png", service = "counter"}]'));
  const extensionPath = path.join(task, "task.hitch.json");
  const extension = JSON.parse(await readFile(extensionPath, "utf8"));
  extension.submission.paths.push("/evidence/screen.png");
  await writeFile(extensionPath, JSON.stringify(extension, null, 2));
  const grader = path.join(task, "tests/test.sh");
  await writeFile(grader, (await readFile(grader, "utf8")).replace("import json", "import json,hashlib").replace("assert value['sealed'] is True", "assert value['sealed'] is True\nassert hashlib.sha256(Path('/evidence/screen.png').read_bytes()).hexdigest()==value['screenshot_sha256']").replace("value['count']==7", "value['clicked_blue'] and value['click_count']==1"));
}

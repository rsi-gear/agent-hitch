import { reapOwnedDockerResources } from "../src/evals/index.js";
import { runCommand } from "../src/foundation/index.js";

const [root, docker = "docker"] = process.argv.slice(2);
if (!root) throw new Error("Docker reaper crash canary root is missing");

await reapOwnedDockerResources({
  root,
  run: async (args) => {
    const result = await runCommand(docker, args, {
      env: process.env,
      timeoutMs: 10_000,
      failureCode: "resource_load_canary_reaper_failed",
    });
    if (args[1] === "rm") {
      process.kill(process.pid, "SIGKILL");
      return new Promise<never>(() => {});
    }
    return result;
  },
});

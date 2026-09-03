import path from "node:path";
import { defaultRoot, invalidInput, packageVersion as readPackageVersion } from "../foundation/index.js";
import { takeOption } from "./arguments.js";
import { helpText } from "./output.js";
import { runsCommand } from "./commands/runs.js";
import { compareCommand } from "./commands/compare.js";
import { listCommand } from "./commands/list.js";
import { inspectCommand } from "./commands/inspect.js";
import { resolveCommand } from "./commands/resolve.js";
import { prepareCommand } from "./commands/prepare.js";
import { runCommand } from "./commands/run.js";
import { evalCommand } from "./commands/eval.js";
import { workspaceCommand } from "./commands/workspace.js";
import { trajectoryCommand } from "./commands/trajectory.js";
import { feedbackCommand } from "./commands/feedback.js";
import { daemonCommand } from "./commands/daemon.js";
import { workerCommand } from "./commands/worker.js";
import { imagesCommand } from "./commands/images.js";
import { verifierCommand } from "./commands/verifier.js";
import { capabilitiesCommand } from "./commands/capabilities.js";

export async function main(argv: string[]): Promise<void> {
  const args = [...argv];
  const root = path.resolve(takeOption(args, "--root") || defaultRoot());
  const command = args.shift();

  switch (command) {
    case "list": return listCommand(args);
    case "inspect": return inspectCommand(args, root);
    case "resolve": return resolveCommand(args, root);
    case "prepare": return prepareCommand(args, root);
    case "run": return runCommand(args, root);
    case "runs": return runsCommand(args, root);
    case "compare": return compareCommand(args, root);
    case "eval": return evalCommand(args, root);
    case "workspace": return workspaceCommand(args, root);
    case "trajectory": return trajectoryCommand(args, root);
    case "verifier": return verifierCommand(args, root);
    case "feedback": return feedbackCommand(args, root);
    case "daemon": return daemonCommand(args, root);
    case "worker": return workerCommand(args, root);
    case "images": return imagesCommand(args, root);
    case "capabilities": return capabilitiesCommand(args);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(helpText());
      return;
    case "--version":
    case "-V":
      process.stdout.write(`hitch ${readPackageVersion()}\n`);
      return;
    default:
      throw invalidInput(`unknown command: ${command}`);
  }
}

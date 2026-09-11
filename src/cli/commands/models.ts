import { invalidInput, readJSON } from "../../foundation/index.js";
import { addLocalModel, addModelFromNode, gcLocalModels, readModelNodeBinding, resolveLocalModel, verifyLocalModel, verifyModelOnNode } from "../../inference/index.js";
import { assertNoArgs, takeFlag, takeOption } from "../arguments.js";

export async function modelsCommand(args: string[], root: string): Promise<void> {
  const action = args.shift();
  if (action === "add-node") {
    const snapshotFile = args.shift();
    const nodeFile = takeOption(args, "--model-node-file"), name = takeOption(args, "--name");
    const force = takeFlag(args, "--force"); takeFlag(args, "--json"); assertNoArgs(args);
    if (!snapshotFile || !nodeFile || !name) throw invalidInput("models add-node requires SNAPSHOT_REF.json --model-node-file BINDING.json --name NAME");
    const manifest = await addModelFromNode(root, name, await readJSON(snapshotFile), await readModelNodeBinding(nodeFile), force);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  if (action === "add") {
    const directory = args.shift();
    const name = takeOption(args, "--name");
    const force = takeFlag(args, "--force");
    const json = takeFlag(args, "--json");
    assertNoArgs(args);
    if (!directory) throw invalidInput("models add requires a checkpoint directory");
    if (!name) throw invalidInput("models add requires --name");
    const manifest = await addLocalModel({ root, directory, name, force });
    if (json) process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    else process.stdout.write(`Added local model local/${name} (${manifest.model_id})\n`);
    return;
  }
  if (action === "inspect") {
    const reference = args.shift();
    const json = takeFlag(args, "--json");
    const verify = takeFlag(args, "--verify");
    const nodeFile = takeOption(args, "--model-node-file");
    assertNoArgs(args);
    if (!reference) throw invalidInput("models inspect requires local/<name> or local/sha256:<digest>");
    const manifest = await resolveLocalModel(root, reference);
    if (verify) {
      if (nodeFile) await verifyModelOnNode(root, manifest, await readModelNodeBinding(nodeFile));
      else await verifyLocalModel(root, manifest);
    }
    if (json) process.stdout.write(`${JSON.stringify({ ...manifest, verified: verify }, null, 2)}\n`);
    else process.stdout.write(`${reference}\n  id       ${manifest.model_id}\n  type     ${manifest.model_type}\n  dtype    ${manifest.dtype}\n  files    ${manifest.files.length}\n  verified ${verify ? "yes" : "not requested"}\n`);
    return;
  }
  if (action === "gc") {
    const apply = takeFlag(args, "--apply");
    const dryRun = takeFlag(args, "--dry-run");
    const json = takeFlag(args, "--json");
    assertNoArgs(args);
    if (apply && dryRun) throw invalidInput("models gc accepts only one of --apply and --dry-run");
    const result = await gcLocalModels(root, apply);
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`${apply ? "Removed" : "Would remove"} ${result.models.length} model(s), ${result.files.length} file(s), ${result.reclaimed_bytes} byte(s)\n`);
    return;
  }
  throw invalidInput("models requires add, add-node, inspect, or gc");
}

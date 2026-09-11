import { invalidInput } from "../../foundation/index.js";
import { registerModelNode, loadModelNodeClient, observeModelNode, readModelNodeBinding, readModelNodeRegistration, reconcileModelNodeService } from "../../inference/index.js";
import { assertNoArgs, takeFlag, takeOption } from "../arguments.js";

export async function modelNodeCommand(args: string[], root: string): Promise<void> {
  const action = args.shift();
  const serviceId = action === "recover-service" ? args.shift() : undefined;
  const file = takeOption(args, "--file");
  takeFlag(args, "--json"); assertNoArgs(args);
  if (!file || !["register", "inspect", "recover-service"].includes(action ?? "")) throw invalidInput("model-node requires register --file CONNECTION.json, inspect --file BINDING.json, or recover-service SERVICE_ID --file CURRENT_BINDING.json");
  if (action === "recover-service") {
    if (!serviceId) throw invalidInput("model-node recover-service requires an exact service ID");
    process.stdout.write(`${JSON.stringify(await reconcileModelNodeService(root, serviceId, await readModelNodeBinding(file)), null, 2)}\n`);
    return;
  }
  if (action === "register") {
    process.stdout.write(`${JSON.stringify(await registerModelNode(root, await readModelNodeRegistration(file)), null, 2)}\n`);
  } else {
    const binding = await readModelNodeBinding(file);
    process.stdout.write(`${JSON.stringify(await observeModelNode(await loadModelNodeClient(root, binding), binding), null, 2)}\n`);
  }
}

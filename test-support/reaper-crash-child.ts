import { readFileSync, writeFileSync } from "node:fs";
import { reapOwnedDockerResources } from "../src/evals/index.js";

const [root, stateFile] = process.argv.slice(2);
if (!root || !stateFile) throw new Error("reaper crash fixture arguments are missing");

interface ResourceState {
  resources: Array<{ id: string; kind: "container" | "network" | "volume"; labels: Record<string, string> }>;
}

const readState = (): ResourceState => JSON.parse(readFileSync(stateFile, "utf8")) as ResourceState;
const writeState = (state: ResourceState): void => writeFileSync(stateFile, `${JSON.stringify(state)}\n`);

await reapOwnedDockerResources({
  root,
  run: async (args) => {
    const state = readState();
    const kind = args[0] as ResourceState["resources"][number]["kind"];
    if (args[1] === "ls") {
      return { stdout: state.resources.filter((resource) => resource.kind === kind).map((resource) => resource.id).join("\n") };
    }
    if (args[1] === "inspect") {
      const resource = state.resources.find((entry) => entry.kind === kind && entry.id === args[2]);
      if (!resource) throw new Error("resource not found");
      return { stdout: JSON.stringify([kind === "container"
        ? { Id: resource.id, Config: { Labels: resource.labels } }
        : kind === "volume" ? { Name: resource.id, Labels: resource.labels } : { Id: resource.id, Labels: resource.labels }]) };
    }
    const id = args.at(-1) as string;
    writeState({ resources: state.resources.filter((resource) => resource.id !== id) });
    process.kill(process.pid, "SIGKILL");
    return new Promise<never>(() => {});
  },
});

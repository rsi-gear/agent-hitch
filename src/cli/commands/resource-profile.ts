import { approveResourceConfigurationFile, collectEvalResourceProfile, importedProfile, importedSavedProfile,
  readResourceProfileIdentityFile, recommendResourceConfiguration, saveResourceProfileOutput } from "../../evals/index.js";
import { assertNoArgs, takeOption } from "../arguments.js";

export async function resourceProfileCommand(action: string, args: string[], root: string): Promise<void> {
  const output = takeOption(args, "--output");
  let result: unknown;
  if (action === "approve") {
    const config = takeOption(args, "--config"), actor = takeOption(args, "--actor"), reason = takeOption(args, "--reason");
    assertNoArgs(args);
    if (!config || !actor || !reason || !output) throw new TypeError("resources approve requires --config, --actor, --reason, and --output");
    result = await approveResourceConfigurationFile(config, actor, reason);
  } else {
    const evalId = takeOption(args, "--eval"), taskId = takeOption(args, "--task"), input = takeOption(args, "--input"), saved = takeOption(args, "--profile");
    const identityFile = takeOption(args, "--identity"), minimum = takeOption(args, "--min-complete-trials");
    assertNoArgs(args);
    if ((evalId ? 1 : 0) + (input ? 1 : 0) + (saved ? 1 : 0) !== 1 || Boolean(evalId) !== Boolean(taskId)) throw new TypeError("use --eval EVAL --task TASK, --input FILE, or --profile FILE");
    const profile = evalId ? await collectEvalResourceProfile({ root, evalId, taskId: taskId! })
      : input ? await importedProfile(input) : await importedSavedProfile(saved!);
    if (action === "profile") {
      if (identityFile || minimum) throw new TypeError("--identity and --min-complete-trials belong to resources recommend");
      result = profile;
    } else result = recommendResourceConfiguration(profile,
      identityFile ? await readResourceProfileIdentityFile(identityFile) : undefined,
      minimum === undefined ? {} : { min_complete_trials: Number(minimum) });
  }
  if (output) {
    process.stdout.write(`${JSON.stringify(await saveResourceProfileOutput(output, result))}\n`);
  } else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

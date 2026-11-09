import { capabilityPlanInput, reserveCapabilityAction, startCapabilityStep, finishCapabilityStep, finishCapabilityAction, unavailableCapabilityAction } from "./capability-actions.js";
/** Host-only authority process used by the Harbor bridge, never run in the agent sandbox. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { durableWriteJSON, withFileLock } from "../foundation/index.js";
import { submitParameterAction, type ParameterState } from "./authority.js";
import { admitTaskParameters } from "./files.js";
import { exact, parseParameterJSON, record, type JSONObject } from "./schema.js";

async function main(): Promise<unknown> {
  const [command, stateFile, taskDirectory, harnessDirectory] = process.argv.slice(2);
  if (!stateFile || !path.isAbsolute(stateFile)) throw new Error("absolute host state file required");
  const maxInput = command?.startsWith("capability-") ? 64 * 1024 * 1024 : 1024 * 1024;
  let input = "";
  for await (const chunk of process.stdin) { input += chunk; if (input.length > maxInput) throw new Error("parameter request too large"); }
  return withFileLock(path.join(path.dirname(stateFile), ".parameter-locks"), "parameters", async () => {
    let state: ParameterState | undefined;
    try { state = parseParameterJSON(await readFile(stateFile, "utf8"), 64 * 1024 * 1024) as ParameterState; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try {
      const request = record(parseParameterJSON(input || "{}", maxInput), "parameter request");
      if (command === "init") {
        if (!taskDirectory) throw new Error("task directory required");
        const admitted = await admitTaskParameters(taskDirectory, { ...(harnessDirectory ? { harnessDirectory } : {}), identity: request as JSONObject });
        if (!admitted) return null;
        if (state && state.execution_id !== admitted.execution_id) throw new Error("parameter execution identity changed; cannot resume");
        state ??= admitted;
        await durableWriteJSON(stateFile, state);
        return state;
      }
      if (!state || state.version !== 1) throw new Error("parameter authority unavailable");
      if (command === "submit") {
        exact(request, ["action", "parameters"], "parameter action");
        if (typeof request.action !== "string") throw new Error("action ID required");
        const result = submitParameterAction(state, request.action, record(request.parameters, "parameters") as JSONObject);
        await durableWriteJSON(stateFile, result.state);
        return result;
      }
      if (command === "capability-reject") throw new Error(String(request.reason).slice(0, 4096));
      if (command === "capability-plan") return { state, context: capabilityPlanInput(state, request) };
      if (command === "capability-runtime") {
        if (!state.bindings.some(binding => binding.id === request.id)) throw new Error("unknown capability runtime binding");
        if (!Number.isSafeInteger(request.deadline_ms) || Number(request.deadline_ms) <= 0) throw new Error("capability deadline is required");
        state.capability_deadline_ms = Math.min(state.capability_deadline_ms ?? Infinity, Number(request.deadline_ms));
        const observation = record(request.observation, "capability runtime observation") as JSONObject;
        state.capability_runtime[String(request.id)] = observation;
      }
      else if (command === "capability-reserve") state = reserveCapabilityAction(state, request.request, request.plan);
      else if (command === "capability-start") state = startCapabilityStep(state, String(request.id), Number(request.index));
      else if (command === "capability-step") state = finishCapabilityStep(state, String(request.id), Number(request.index), request.result);
      else if (command === "capability-finish") state = finishCapabilityAction(state, String(request.id), request.result);
      else if (command === "capability-unavailable") state = unavailableCapabilityAction(state, String(request.id), String(request.reason));
      else if (command === "show") return state;
      else throw new Error("unknown parameter authority command");
      await durableWriteJSON(stateFile, state);
      return { state };
    } catch (error) {
      const reason = (error as Error).message.slice(0, 4096);
      if ((command === "submit" || command?.startsWith("capability-")) && state) {
        state.audit.push({ recorded_at: new Date().toISOString(), actor: "target", path: "", old_value: state.effective, new_value: { rejected_input: input.slice(0, 4096) },
          rule: null, phase: "training_start", accepted: false, reason });
        await durableWriteJSON(stateFile, state);
        return { accepted: false, state, reason };
      }
      if (command === "init") await durableWriteJSON(stateFile + ".admission-error.json", { version: 1, source: "host_parameter_authority", accepted: false,
        reason, code: (error as { code?: string }).code ?? "invalid_parameter_contract", audit: (error as { audit?: unknown }).audit ?? [] });
      throw error;
    }
  });
}
try { process.stdout.write(JSON.stringify(await main()) + "\n"); }
catch (error) { process.stderr.write(JSON.stringify({ error: (error as Error).message, code: (error as { code?: string }).code ?? "parameter_authority_unavailable" }) + "\n"); process.exitCode = 1; }

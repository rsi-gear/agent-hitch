import path from "node:path";
import type { InteractionCaptureRefV1, ModelCapturePlanV1, ModelProxyRouteV1 } from "../domain/index.js";
import { HitchError } from "../foundation/index.js";
import { HostModelProxy } from "../model-access/index.js";
import { readModelProxyRuntimeState, writeModelProxyRuntimeState } from "./model-proxy-runtime-state.js";

export interface EvalModelCaptureRuntime {
  plan: ModelCapturePlanV1;
  route?: ModelProxyRouteV1;
  exporter?: {
    route: ModelProxyRouteV1;
    plan: ModelCapturePlanV1;
    finalizeRun(runId: string, destinationRunDirectory: string): Promise<InteractionCaptureRefV1>;
  };
  finalizeRun?: (runId: string, destinationRunDirectory: string) => Promise<InteractionCaptureRefV1>;
  close(): Promise<void>;
}

export async function startEvalModelCaptureRuntime(input: {
  plan: ModelCapturePlanV1;
  evalId: string;
  evalDirectory: string;
  env: NodeJS.ProcessEnv;
}): Promise<EvalModelCaptureRuntime> {
  if (input.plan.effective_mode !== "proxy" && input.plan.effective_mode !== "hybrid") {
    return { plan: input.plan, close: async () => undefined };
  }
  if (input.plan.topology === "in-sandbox") {
    return { plan: input.plan, close: async () => undefined };
  }
  let proxy: HostModelProxy | undefined;
  try {
    const persisted = await readModelProxyRuntimeState(input.evalDirectory, input.evalId, input.plan);
    proxy = await HostModelProxy.start({
      captureRoot: path.join(input.evalDirectory, "model-capture"),
      evalId: input.evalId,
      mode: input.plan.effective_mode,
      required: input.plan.required,
      env: input.env,
      ...(persisted ? {
        listenPort: persisted.listen_port,
        capabilityToken: persisted.capability_token,
        resumeExisting: true,
      } : {}),
    });
    await writeModelProxyRuntimeState({
      evalDirectory: input.evalDirectory,
      evalId: input.evalId,
      plan: input.plan,
      identity: proxy.runtimeIdentity(),
      previous: persisted,
    });
    const activeProxy = proxy;
    const finalizeRun = (runId: string, destination: string) => activeProxy.finalizeRun(runId, destination);
    return {
      plan: input.plan,
      route: proxy.route,
      exporter: { route: proxy.route, plan: input.plan, finalizeRun },
      finalizeRun,
      close: () => activeProxy.close(),
    };
  } catch (error) {
    await proxy?.close().catch(() => undefined);
    if (input.plan.required) {
      throw new HitchError("required model proxy failed to start", {
        code: "model_proxy_unavailable",
        exitCode: 10,
        cause: error,
      });
    }
    return {
      plan: {
        requested_mode: input.plan.requested_mode,
        effective_mode: "native",
        required: false,
        degraded_reason: "model-proxy-start-failed",
      },
      close: async () => undefined,
    };
  }
}

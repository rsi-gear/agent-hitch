import path from "node:path";
import { isIP } from "node:net";
import type { InteractionCaptureRefV1, ModelCapturePlanV1, ModelEndpointBindingV1, ModelProxyRouteV1 } from "../domain/index.js";
import { HitchError, runCommand } from "../foundation/index.js";
import { HostModelProxy } from "../model-access/index.js";
import { readModelProxyRuntimeState, writeModelProxyRuntimeState } from "./model-proxy-runtime-state.js";
import { resolveTrainingEndpoint } from "../model-access/index.js";
import type { TrainingExternalBindingV1 } from "../domain/index.js";

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
  /** Defaults to controller-owned host-side runtimes. Remote workers opt in to their sealed in-sandbox plan. */
  runtimeTopology?: "host-side" | "in-sandbox";
  /** A sealed remote plan cannot be rewritten after dispatch when optional proxy startup fails. */
  preservePlanOnOptionalFailure?: boolean;
  managedInference?: { binding: ModelEndpointBindingV1; credential: string; modelId: import("../domain/index.js").Sha256 };
  trainingBinding?: TrainingExternalBindingV1;
  remoteRelay?: { binding: import("../domain/index.js").RemoteModelBindingV2; baseUrl: string; credential: string; bindRun(runId: string): Promise<void> };
}): Promise<EvalModelCaptureRuntime> {
  if (input.plan.effective_mode !== "proxy" && input.plan.effective_mode !== "hybrid") {
    return { plan: input.plan, close: async () => undefined };
  }
  const runtimeTopology = input.runtimeTopology ?? "host-side";
  if ((input.plan.topology ?? "host-side") !== runtimeTopology) {
    return { plan: input.plan, close: async () => undefined };
  }
  let proxy: HostModelProxy | undefined;
  try {
    if (Number(!!input.trainingBinding) + Number(!!input.managedInference) + Number(!!input.remoteRelay) > 1) throw new TypeError("model route bindings are exclusive");
    const training = input.trainingBinding ? await resolveTrainingEndpoint(path.resolve(input.evalDirectory, "../.."), input.trainingBinding) : undefined;
    const persisted = await readModelProxyRuntimeState(input.evalDirectory, input.evalId, input.plan);
    const binding = await resolveModelProxyBinding(input.env);
    proxy = await HostModelProxy.start({
      captureRoot: path.join(input.evalDirectory, "model-capture"),
      evalId: input.evalId,
      mode: input.plan.effective_mode,
      required: input.plan.required,
      env: input.env,
      topology: runtimeTopology,
      bindHost: binding.bindHost,
      advertisedHost: binding.advertisedHost,
      ...(input.remoteRelay ? {
        upstreams: { openai: input.remoteRelay.baseUrl }, upstreamAuthorizations: { openai: `Bearer ${input.remoteRelay.credential}` },
        credentialValues: [input.remoteRelay.credential], onRun: input.remoteRelay.bindRun,
        ...(input.remoteRelay.binding.kind === "training-external" ? { trainingBinding: input.remoteRelay.binding.training } : {
          managedInferenceIdentity: { inference_id: input.remoteRelay.binding.inference_id, model_id: input.remoteRelay.binding.model_id, model_node: input.remoteRelay.binding.model_node },
        }),
      } : {}),
      ...(training ? { trainingEndpoint: training, upstreams: { openai: training.base_url },
        upstreamAuthorizations: { openai: `Bearer ${training.credential}` }, upstreamWireModels: { openai: training.binding.expectedPolicyVersion },
        credentialValues: [training.credential] } : {}),
      ...(input.managedInference ? {
        upstreams: { openai: input.managedInference.binding.base_url },
        upstreamAuthorizations: { openai: `Bearer ${input.managedInference.credential}` },
        upstreamWireModels: { openai: input.managedInference.binding.wire_model },
        credentialValues: [input.managedInference.credential],
        managedInferenceIdentity: {
          inference_id: input.managedInference.binding.inference_id,
          model_id: input.managedInference.modelId,
          ...(input.managedInference.binding.model_node ? { model_node: input.managedInference.binding.model_node } : {}),
        },
      } : {}),
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
    return input.preservePlanOnOptionalFailure ? {
      plan: input.plan,
      close: async () => undefined,
    } : {
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

export async function resolveModelProxyBinding(
  env: NodeJS.ProcessEnv,
  options: {
    platform?: NodeJS.Platform;
    inspectDockerBridge?: (docker: string, env: NodeJS.ProcessEnv) => Promise<unknown>;
  } = {},
): Promise<{ bindHost: string; advertisedHost: string }> {
  const configuredBind = env.HITCH_MODEL_PROXY_BIND_HOST?.trim();
  const configuredAdvertised = env.HITCH_MODEL_PROXY_ADVERTISED_HOST?.trim();
  if (configuredBind) return { bindHost: safeBindAddress(configuredBind), advertisedHost: configuredAdvertised || "host.docker.internal" };
  if ((options.platform ?? process.platform) !== "linux") {
    return { bindHost: "127.0.0.1", advertisedHost: configuredAdvertised || "host.docker.internal" };
  }
  const docker = env.HITCH_DOCKER_PATH?.trim() || "docker";
  let configs: unknown;
  if (options.inspectDockerBridge) {
    configs = await options.inspectDockerBridge(docker, env);
  } else {
    const inspected = await runCommand(docker, ["network", "inspect", "bridge", "--format", "{{json .IPAM.Config}}"], {
      env,
      timeoutMs: 5_000,
      failureCode: "model_proxy_bind_unavailable",
      failureExitCode: 10,
    });
    try { configs = JSON.parse(inspected.stdout); }
    catch (error) { throw new HitchError("Docker bridge gateway response is invalid", { code: "model_proxy_bind_unavailable", exitCode: 10, cause: error }); }
  }
  if (!Array.isArray(configs)) throw new HitchError("Docker bridge has no IPAM configuration", { code: "model_proxy_bind_unavailable", exitCode: 10 });
  const gateway = configs.map((entry) => entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>).Gateway : undefined)
    .find((value) => typeof value === "string" && isIP(value) !== 0) as string | undefined;
  if (!gateway) throw new HitchError("Docker bridge has no specific host gateway", { code: "model_proxy_bind_unavailable", exitCode: 10 });
  return { bindHost: safeBindAddress(gateway), advertisedHost: configuredAdvertised || "host.docker.internal" };
}

function safeBindAddress(value: string): string {
  if (isIP(value) === 0 || value === "0.0.0.0" || value === "::") {
    throw new HitchError("model proxy bind address must be a specific local IP", { code: "model_proxy_bind_unavailable", exitCode: 10 });
  }
  return value;
}

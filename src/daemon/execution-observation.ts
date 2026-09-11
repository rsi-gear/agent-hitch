import type { IncomingMessage, ServerResponse } from "node:http";
import type { ExecutionObservationSourceV2, ExecutionProviderStatusV1 } from "../domain/index.js";
import type { RemoteExecutionObservationCoordinator } from "../control-plane/index.js";
import { HitchError, invalidInput, sha256JSON } from "../foundation/index.js";
import { json, readBodyJSON } from "./http.js";

export async function executionObservation(request: IncomingMessage, response: ServerResponse, input: {
  source: ExecutionObservationSourceV2 | undefined;
  local: ExecutionProviderStatusV1 | undefined;
  instanceId: string;
  remote: RemoteExecutionObservationCoordinator;
}): Promise<void> {
  const body = await readBodyJSON(request) as Record<string, unknown>;
  if (!body || Array.isArray(body) || body.schema_version !== "2" || typeof body.provider !== "string"
    || typeof body.nonce !== "string" || !/^[a-f0-9]{32}$/.test(body.nonce)
    || Object.keys(body).some(key => !["schema_version", "provider", "nonce"].includes(key))) {
    throw invalidInput("execution observation requires schema_version 2, provider and a 32-hex nonce");
  }
  if (!input.local || body.provider !== input.local.provider) {
    if (!input.source) throw new HitchError("daemon has no startup runtime observation", { code: "execution_observation_unavailable", exitCode: 12 });
    const controller = new AbortController(), abort = () => controller.abort();
    response.once("close", abort);
    try {
      const before = await input.source.observeRuntime();
      const result = await input.remote.observe(body.provider, body.nonce, controller.signal);
      const runtime = await input.source.observeRuntime();
      runtime.unchanged &&= before.unchanged;
      const challenge = result.challenge;
      json(response, 200, { schema_version: "2", nonce: challenge.nonce, provider: challenge.provider,
        worker_id: challenge.worker_id, collision_domain_id: challenge.collision_domain_id, generation: challenge.generation,
        daemon_instance_id: input.instanceId, daemon_runtime: runtime, worker_runtime: result.runtime,
        environment: result.environment, environment_digest: result.environment_digest });
    } finally { response.removeListener("close", abort); }
    return;
  }
  if (!input.source) throw new HitchError("daemon has no startup runtime observation; restart it with a supported Hitch CLI", { code: "execution_observation_unavailable", exitCode: 12 });
  const { runtime, environment } = await input.source.observe();
  json(response, 200, { schema_version: "2", nonce: body.nonce, provider: input.local.provider,
    worker_id: input.local.worker_id, collision_domain_id: input.local.collision_domain_id, generation: null,
    daemon_instance_id: input.instanceId, daemon_runtime: runtime, environment, environment_digest: sha256JSON(environment) });
}

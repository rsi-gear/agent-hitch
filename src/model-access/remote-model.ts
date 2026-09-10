import type { ModelEndpointBindingV1, RemoteModelBindingV2, Sha256 } from "../domain/index.js";
import { asSha256, parseModelNodeBinding } from "../domain/index.js";
import { HitchError } from "../foundation/index.js";
import { bindTrainingRun, parseTrainingBinding } from "./training.js";
import type { RegisteredTrainingEndpoint } from "./training.js";

export type RemoteModelTargetV2 = { kind: "training-external"; endpoint: RegisteredTrainingEndpoint } | {
  kind: "managed-inference"; binding: ModelEndpointBindingV1; credential: string; modelId: Sha256; maxOutputTokens: number;
};
export function parseRemoteModelBinding(value: unknown): RemoteModelBindingV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("remote model binding must be an object");
  const r = value as Record<string, unknown>;
  const fields = r.kind === "training-external" ? ["schema_version", "kind", "training"]
    : ["schema_version", "kind", "inference_id", "model_id", "model_node", "api", "max_output_tokens"];
  if (r.schema_version !== "2" || Object.keys(r).some(key => !fields.includes(key)) || fields.some(key => !(key in r))) throw new TypeError("invalid remote model binding fields");
  if (r.kind === "training-external") return { schema_version: "2", kind: r.kind, training: parseTrainingBinding(r.training) };
  if (r.kind !== "managed-inference" || !["chat-completions", "responses"].includes(String(r.api))
    || !Number.isSafeInteger(r.max_output_tokens) || Number(r.max_output_tokens) < 1) throw new TypeError("invalid remote managed model contract");
  return { schema_version: "2", kind: r.kind, inference_id: asSha256(r.inference_id), model_id: asSha256(r.model_id),
    model_node: parseModelNodeBinding(r.model_node), api: r.api as "responses" | "chat-completions", max_output_tokens: Number(r.max_output_tokens) };
}
export function remoteModelBinding(target: RemoteModelTargetV2): RemoteModelBindingV2 {
  return parseRemoteModelBinding(target.kind === "training-external" ? { schema_version: "2", kind: target.kind, training: target.endpoint.binding }
    : { schema_version: "2", kind: target.kind, inference_id: target.binding.inference_id, model_id: target.modelId,
      model_node: target.binding.model_node, api: target.binding.api, max_output_tokens: target.maxOutputTokens });
}

/** The caller has authenticated the exact worker lease. This API exposes generation only. */
export async function callRemoteModel(target: RemoteModelTargetV2, runId: string, operation: "bind" | "generate", body: unknown, signal: AbortSignal): Promise<Response> {
  const binding = remoteModelBinding(target);
  if (!/^run_[a-f0-9]{32}$/.test(runId)) throw new TypeError("remote model needs a canonical run identity");
  if (target.kind === "training-external") {
    if (Date.parse(target.endpoint.binding.expiresAt) <= Date.now()) throw new HitchError("training policy lease expired", { code: "training_lease_expired", exitCode: 12 });
    if (operation === "bind") await bindTrainingRun(target.endpoint, runId, signal);
  }
  if (operation === "bind") return Response.json({ schema_version: "2", run_id: runId, model_binding: binding });
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("remote generation requires a JSON envelope");
  const request = body as { payload?: unknown; idempotency_key?: unknown };
  if (Object.keys(body).some(key => !["payload", "idempotency_key"].includes(key)) || !request.payload
    || typeof request.payload !== "object" || Array.isArray(request.payload)
    || request.idempotency_key !== undefined && (typeof request.idempotency_key !== "string" || !request.idempotency_key
      || request.idempotency_key.length > 256 || /[\s\0]/.test(request.idempotency_key))) throw new TypeError("invalid remote generation envelope");
  const api = binding.kind === "training-external" ? "chat-completions" : binding.api;
  const url = target.kind === "training-external" ? target.endpoint.base_url : target.binding.base_url;
  const credential = target.kind === "training-external" ? target.endpoint.credential : target.credential;
  const model = target.kind === "training-external" ? target.endpoint.binding.expectedPolicyVersion : target.binding.wire_model;
  if (typeof credential !== "string" || !credential || /[\r\n]/.test(credential)) throw new TypeError("missing controller model credential");
  return fetch(`${url.replace(/\/$/, "")}/${api === "responses" ? "responses" : "chat/completions"}`, {
    method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json",
      ...(typeof request.idempotency_key === "string" ? { "idempotency-key": request.idempotency_key } : {}) },
    body: JSON.stringify({ ...request.payload, model }), signal, redirect: "error",
  });
}

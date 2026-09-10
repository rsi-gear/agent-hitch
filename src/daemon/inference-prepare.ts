import type { IncomingMessage, ServerResponse } from "node:http";
import type { LocalInferenceSelectionV1 } from "../domain/index.js";
import type { LocalInferenceManager } from "../control-plane/index.js";
import { HitchError, invalidInput } from "../foundation/index.js";
import { readBodyJSON } from "./http.js";
import { parseModelNodeBinding } from "../domain/index.js";

export async function prepareInference(request: IncomingMessage, response: ServerResponse, manager: LocalInferenceManager): Promise<void> {
  const value = await readBodyJSON(request);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput("prepare requires an object");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["model", "device", "profile", "offline", "inference_id", "model_node"].includes(key))
    || typeof body.model !== "string" || !body.model.startsWith("local/")
    || !["auto", "cpu", "cuda", "metal"].includes(String(body.device))
    || !["baseline", "throughput"].includes(String(body.profile)) || typeof body.offline !== "boolean") {
    throw invalidInput("invalid local inference preparation selection");
  }
  if (body.model_node !== undefined) body.model_node = parseModelNodeBinding(body.model_node);
  if (body.inference_id !== undefined && (typeof body.inference_id !== "string" || !/^sha256:[a-f0-9]{64}$/.test(body.inference_id))) throw invalidInput("invalid inference lock digest");
  const controller = new AbortController();
  const abort = () => { if (!response.writableEnded) controller.abort(); };
  request.once("aborted", abort);
  response.once("close", abort);
  // OCI download plus cold model startup can exceed a regular HTTP header timeout.
  // Stream progress immediately; the final result/error is still structured JSON.
  response.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
  const emit = (event: Record<string, unknown>) => { if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`); };
  emit({ type: "inference.preparing", message: "Preparing and validating local inference runtime" });
  const heartbeat = setInterval(() => emit({ type: "inference.progress" }), 15_000);
  heartbeat.unref();
  try {
    const prepared = await manager.prepare(body as unknown as LocalInferenceSelectionV1, controller.signal, emit);
    emit({ type: "inference.prepared", result: prepared });
  } catch (error) {
    emit({ type: "inference.prepare.failed", error: { message: (error as Error).message,
      code: error instanceof HitchError ? error.code : "inference_route_unavailable", exit_code: error instanceof HitchError ? error.exitCode : 12 } });
  } finally {
    clearInterval(heartbeat);
    request.removeListener("aborted", abort);
    response.removeListener("close", abort);
    response.end();
  }
}

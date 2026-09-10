import type { IncomingMessage, ServerResponse } from "node:http";
import type { RemoteExecutionObservationCoordinator, RemoteWorkerRegistry } from "../control-plane/index.js";
import { parseExecutionObservationReceipt } from "../control-plane/index.js";
import { HitchError, invalidInput } from "../foundation/index.js";
import { json, readBodyJSON } from "./http.js";

export async function handleWorkerObservationRoute(input: {
  request: IncomingMessage; response: ServerResponse; url: URL;
  registry: RemoteWorkerRegistry; observations: RemoteExecutionObservationCoordinator;
}): Promise<boolean> {
  const { request, response, url, registry, observations } = input;
  const match = url.pathname.match(/^\/v2\/workers\/(worker_[a-z0-9][a-z0-9_-]{0,62})\/execution-observation$/);
  if (!match || !["GET", "POST"].includes(request.method ?? "")) return false;
  const workerId = match[1]!, token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization ?? "")?.[1];
  response.setHeader("cache-control", "no-store");
  const authorizedGeneration = token ? await registry.authenticatedGeneration(workerId, token) : null;
  if (authorizedGeneration === null) {
    json(response, 401, { error: { code: "unauthorized", message: "missing or invalid worker credential" } });
    return true;
  }
  if (request.method === "GET") {
    const generation = url.searchParams.get("generation");
    if (!generation || !/^[1-9][0-9]*$/.test(generation) || !Number.isSafeInteger(Number(generation))) throw invalidInput("observation requires a valid worker generation");
    if (Number(generation) !== authorizedGeneration) throw credentialMismatch();
    json(response, 200, { schema_version: "2", challenge: await observations.poll(workerId, Number(generation)) });
  } else {
    const receipt = parseExecutionObservationReceipt(await readBodyJSON(request, 64 * 1024));
    if (receipt.challenge.generation !== authorizedGeneration) throw credentialMismatch();
    await observations.submit(workerId, receipt);
    json(response, 200, { schema_version: "2", accepted: true });
  }
  return true;
}
function credentialMismatch() { return new HitchError("worker observation generation differs from its authenticated credential", { code: "worker_generation_mismatch", exitCode: 12 }); }

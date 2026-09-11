import { randomBytes } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { RemoteModelBindingV2 } from "../domain/index.js";
import { sha256JSON } from "../foundation/index.js";
import { parseRemoteModelBinding } from "./remote-model-routes.js";
import type { RemoteWorkerExecutorInput } from "./remote-worker-runner.js";

/** Worker-only HTTP adapter for the existing capture proxy. It owns no model-node credential. */
export async function startWorkerModelRelay(input: {
  binding: RemoteModelBindingV2; relay: NonNullable<RemoteWorkerExecutorInput["relayModel"]>; signal: AbortSignal;
}) {
  const binding = parseRemoteModelBinding(input.binding), credential = randomBytes(32).toString("hex");
  const controller = new AbortController(), signal = AbortSignal.any([input.signal, controller.signal]);
  let runId: string | undefined;
  const api = binding.kind === "training-external" ? "chat-completions" : binding.api;
  const endpoint = api === "responses" ? "/v1/responses" : "/v1/chat/completions";
  const server = http.createServer((request, response) => {
    const serve = async () => {
      if (signal.aborted || !runId || request.method !== "POST" || request.url !== endpoint || request.headers.authorization !== `Bearer ${credential}`) {
        response.writeHead(403); response.end(); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 32 * 1024 * 1024) throw new TypeError("model request exceeds limit"); chunks.push(Buffer.from(chunk)); }
      const key = request.headers["idempotency-key"];
      if (key !== undefined && (typeof key !== "string" || !key || key.length > 256 || /[\s\0]/.test(key))) throw new TypeError("invalid generation idempotency key");
      const disconnected = new AbortController();
      const abort = () => { if (!response.writableEnded) disconnected.abort(); };
      response.once("close", abort);
      try {
        const result = await input.relay(runId, "generate", {
          payload: JSON.parse(Buffer.concat(chunks).toString("utf8")), ...(key ? { idempotency_key: key } : {}),
        }, AbortSignal.any([signal, disconnected.signal]));
        response.writeHead(result.status, { "content-type": result.headers.get("content-type") ?? "application/json", "cache-control": "no-store",
          ...(result.headers.has("x-gear-receipt-id") ? { "x-gear-receipt-id": result.headers.get("x-gear-receipt-id")! } : {}) });
        if (result.body) await pipeline(Readable.fromWeb(result.body as import("node:stream/web").ReadableStream<Uint8Array>), response);
        else response.end();
      } finally { response.removeListener("close", abort); disconnected.abort(); }
    };
    serve().catch(() => {
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(502, { "content-type": "application/json" }); response.end('{"error":{"code":"remote_model_unavailable"}}');
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  return {
    binding, baseUrl: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/v1`, credential,
    bindRun: async (id: string) => {
      if (signal.aborted || !/^run_[a-f0-9]{32}$/.test(id) || runId && runId !== id) throw new TypeError("remote relay canonical run is fenced");
      const result = await input.relay(id, "bind", null, signal);
      const proof = await result.json() as { schema_version?: unknown; run_id?: unknown; model_binding?: unknown };
      if (!result.ok || proof.schema_version !== "2" || proof.run_id !== id || sha256JSON(proof.model_binding) !== sha256JSON(binding)) throw new TypeError("remote controller did not attest the frozen model/run binding");
      runId = id;
    },
    close: async () => { controller.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

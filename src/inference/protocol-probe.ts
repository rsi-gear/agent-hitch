import { HitchError } from "../foundation/index.js";

/** Both launchers prove the same streaming/non-streaming protocol before use. */
export async function probeSGLangProtocol(request: typeof fetch, baseUrl: string, token: string, wireModel: string, api: "responses" | "chat-completions"): Promise<void> {
  const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
  for (const stream of [false, true]) {
    const body = api === "responses"
      ? { model: wireModel, input: "Reply with one word.", max_output_tokens: 8, temperature: 0, store: false, stream }
      : { model: wireModel, messages: [{ role: "user", content: "Reply with one word." }], max_tokens: 8, temperature: 0, stream };
    const response = await request(`${baseUrl}/v1/${api === "responses" ? "responses" : "chat/completions"}`, {
      method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw failure(`SGLang ${api} probe returned HTTP ${response.status}`);
    if (stream && !response.headers.get("content-type")?.includes("text/event-stream")) throw failure("SGLang streaming probe did not return SSE");
    const chunks = stream ? (await response.text()).split(/\r?\n/).filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
      .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>) : [await response.json() as Record<string, unknown>];
    if (api === "responses") {
      const body = stream ? chunks.findLast(event => event.type === "response.completed" || event.type === "response.incomplete")?.response as { status?: unknown } | undefined : chunks[0];
      if (body?.status !== "completed" && body?.status !== "incomplete") throw failure("SGLang Responses probe lacks a successful terminal payload");
    } else if (!chunks.some(chunk => (chunk.choices as Array<{ finish_reason?: unknown }> | undefined)?.some(choice => ["stop", "length"].includes(String(choice.finish_reason))))) {
      throw failure("SGLang Chat Completions probe lacks terminal output");
    }
  }
}
function failure(message: string): HitchError { return new HitchError(message, { code: "inference_protocol_unsupported", exitCode: 12 }); }

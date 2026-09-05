import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";

const client = await import(pathToFileURL(path.resolve("integrations/harbor/hitch_tool_client.mjs")).href);
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lL8AAAAASUVORK5CYII=";
const envelope = (content: unknown[]) => JSON.stringify({ protocol: "hitch-tool-result@1", content });

test("screenshot tool transport authenticates once and preserves the actual image bytes", async (t) => {
  let calls = 0;
  const server = createServer(async (request, response) => {
    calls++;
    assert.equal(request.url, "/call");
    assert.equal(request.headers.authorization, "Bearer synthetic-token");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { name: "screenshot", arguments: {} });
    response.end(envelope([{ type: "text", text: "Native screenshot" }, { type: "image", mimeType: "image/png", data: png }]));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const result = JSON.parse(await client.invokeTool({ endpoint: `http://127.0.0.1:${address.port}/`, token: "synthetic-token", tools: [{ name: "screenshot" }] }, "screenshot", {}));
  const image = result.content[1];
  t.after(() => rm(path.dirname(image.path), { recursive: true, force: true }));
  assert.equal(calls, 1);
  assert.ok(path.isAbsolute(image.path));
  assert.equal(image.data, undefined);
  assert.deepEqual(await readFile(image.path), Buffer.from(png, "base64"));
  assert.equal(image.sha256, createHash("sha256").update(Buffer.from(png, "base64")).digest("hex"));
  assert.equal((await stat(image.path)).mode & 0o777, 0o600);
});

test("tool images reject invalid encodings and MIME types without changing legacy outputs", async () => {
  for (const text of ['{"content":[{"type":"image","data":"arbitrary"}]}', "plain text", "null"]) assert.equal(await client.materializeToolResult(text), text);
  for (const block of [
    { type: "image", mimeType: "image/svg+xml", data: png },
    { type: "image", mimeType: "image/jpeg", data: png },
    { type: "image", mimeType: "image/png", data: png + "!" },
    { type: "image", mimeType: "image/png", data: "A".repeat(6 * 1024 * 1024) },
    { type: "image", mimeType: "image/png", url: "http://example.com/secret" },
  ]) await assert.rejects(client.materializeToolResult(envelope([block])), /tool image/i);
});

test("tool stdin accepts chunked JSON without treating fd zero as a filesystem path", async () => {
  const bytes = Buffer.from('{"text":"桌面"}');
  assert.deepEqual(await client.readToolArguments("-", Readable.from([bytes.subarray(0, 10), bytes.subarray(10)])), { text: "桌面" });
  await assert.rejects(client.readToolArguments("-", Readable.from([Buffer.alloc(1024 * 1024)])), /exceed/);
});

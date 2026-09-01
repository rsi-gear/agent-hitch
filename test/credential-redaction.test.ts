import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { CREDENTIAL_REDACTION_MARKER, createCredentialRedactionTransform, redactCredentialText } from "../src/foundation/index.js";

test("credential redaction covers known values, headers, bearer tokens, and query secrets", () => {
  const secret = "custom-value-that-is-not-provider-shaped";
  const result = redactCredentialText([
    `plain=${secret}`,
    "Authorization: Bearer abcdefghijklmnop",
    '"client_secret":"do-not-store"',
    "https://example.test/v1?api_key=query-value&safe=yes",
    "X-Custom-Secret: custom-header-value with spaces",
  ].join("\n"), [secret]);
  assert.equal(result.text.includes(secret), false);
  assert.equal(result.text.includes("abcdefghijklmnop"), false);
  assert.equal(result.text.includes("do-not-store"), false);
  assert.equal(result.text.includes("query-value"), false);
  assert.equal(result.text.includes("custom-header-value"), false);
  assert.equal(result.text.includes("$1"), false);
  assert.ok(result.text.includes(CREDENTIAL_REDACTION_MARKER));
  assert.equal(result.redactions.get("known-credential-value-v1"), 1);
  assert.ok((result.redactions.get("sensitive-field-v1") ?? 0) >= 2);
});

test("stream redaction handles a credential split across chunks", async () => {
  const secret = "split-across-stream-boundaries";
  const transform = createCredentialRedactionTransform([secret]);
  let output = "";
  transform.setEncoding("utf8");
  transform.on("data", (chunk: string) => { output += chunk; });
  transform.write("prefix split-across-");
  transform.write("stream-boundaries suffix\nnext line\n");
  transform.end();
  await once(transform, "end");
  assert.equal(output.includes(secret), false);
  assert.equal(output, "prefix [REDACTED] suffix\nnext line\n");
});

test("stream redaction does not leak a multiline credential", async () => {
  const secret = "private-key-line-one\nprivate-key-line-two";
  const transform = createCredentialRedactionTransform([secret]);
  let output = "";
  transform.setEncoding("utf8");
  transform.on("data", (chunk: string) => { output += chunk; });
  transform.end(`before\n${secret}\nafter\n`);
  await once(transform, "end");
  assert.equal(output.includes("private-key-line-one"), false);
  assert.equal(output.includes("private-key-line-two"), false);
  assert.equal(output, "before\n[REDACTED]\n[REDACTED]\nafter\n");
});

test("stream redaction drops an oversized unterminated line instead of leaking it", async () => {
  const transform = createCredentialRedactionTransform(["hidden"], 16);
  let output = "";
  transform.setEncoding("utf8");
  transform.on("data", (chunk: string) => { output += chunk; });
  transform.write("hidden-01234567890123456789");
  transform.write("still-hidden\nvisible\n");
  transform.end();
  await once(transform, "end");
  assert.equal(output.includes("hidden"), false);
  assert.equal(output, "[REDACTED OVERSIZED LOG LINE]\nvisible\n");
});

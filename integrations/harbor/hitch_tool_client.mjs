// Generic tool-server@1 CLI transport. All tool names and schemas are package data.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

function decodeImage(block) {
  const extension = IMAGE_TYPES[block.mimeType];
  if (!extension || typeof block.data !== "string" || block.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error("Unsupported or oversized tool image");
  const bytes = Buffer.from(block.data, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== block.data) throw new Error("Invalid tool image encoding");
  const valid = block.mimeType === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    : block.mimeType === "image/jpeg" ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!valid) throw new Error("Tool image MIME type differs from its bytes");
  return { bytes, extension };
}

// Only this explicit envelope opts in. Existing arbitrary JSON/text tool
// responses (including objects containing a content field) stay byte-for-byte.
export async function materializeToolResult(text) {
  let result;
  try { result = JSON.parse(text); } catch { return text; }
  if (result?.protocol !== "hitch-tool-result@1") return text;
  if (!Array.isArray(result.content) || result.content.length > 64) throw new Error("Invalid tool result content");
  let imageCount = 0;
  const decoded = result.content.map((block) => {
    if (block?.type === "text" && typeof block.text === "string") return { text: block.text };
    if (block?.type !== "image" || ++imageCount > 8) throw new Error("Unsupported tool content block");
    return decodeImage(block);
  });
  const directory = imageCount ? await mkdtemp(path.join(tmpdir(), "hitch-observations-")) : null;
  try {
    const content = [];
    for (const [index, block] of decoded.entries()) {
      if ("text" in block) { content.push({ type: "text", text: block.text }); continue; }
      const target = path.join(directory, `${index}.${block.extension}`);
      await writeFile(target, block.bytes, { flag: "wx", mode: 0o600 });
      content.push({ type: "image", path: target, mimeType: result.content[index].mimeType,
        bytes: block.bytes.length, sha256: createHash("sha256").update(block.bytes).digest("hex") });
    }
    return JSON.stringify({ ...result, content });
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function invokeTool(binding, name, args) {
  if (!binding.tools.some((tool) => tool.name === name)) throw new Error("Unknown tool name; use list");
  const response = await fetch(new URL("call", binding.endpoint), {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${binding.token}` },
    body: JSON.stringify({ name, arguments: args }), signal: AbortSignal.timeout(60000), redirect: "error",
  });
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw new Error("Tool response exceeds 16 MiB");
    chunks.push(chunk);
  }
  const result = Buffer.concat(chunks).toString("utf8");
  if (!response.ok) throw new Error(`Tool transport ${response.status}: ${result}`);
  return materializeToolResult(result);
}

export async function readToolArguments(argument, input = process.stdin) {
  if (argument !== "-") return JSON.parse(argument);
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size >= 1024 * 1024) throw new Error("Tool arguments exceed 1 MiB");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const binding = JSON.parse(await readFile("/tmp/hitch-tool-binding.json", "utf8"));
  const [name, argument = "{}"] = process.argv.slice(2);
  const result = !name || name === "list" ? JSON.stringify(binding.tools, null, 2)
    : await invokeTool(binding, name, await readToolArguments(argument));
  process.stdout.write(`${result}\n`);
}

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Explicit credential handoff for isolated Harbor containers. Never included in
 * the exported run's runtime-home, task tree, command line or artifact image.
 * The container provider owns deletion when the trial is released.
 */
export function codexContainerAuth(env = process.env): Record<string, string> | undefined {
  const encoded = env.HITCH_CODEX_AUTH_JSON;
  if (!encoded) return undefined;
  if (env.HITCH_HARBOR_INTERNAL !== "1") throw new Error("HITCH_CODEX_AUTH_JSON is only supported inside a managed Harbor container");
  if (encoded.length > 100_000) throw new Error("Codex auth document exceeds size limit");
  let document: unknown;
  try { document = JSON.parse(encoded); } catch { throw new Error("Codex auth document is invalid JSON"); }
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("Codex auth document must be an object");
  const directory = mkdtempSync(path.join(tmpdir(), "hitch-codex-auth-"));
  writeFileSync(path.join(directory, "auth.json"), encoded, { mode: 0o600 });
  return { CODEX_HOME: directory };
}

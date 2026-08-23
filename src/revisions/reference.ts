import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { invalidInput } from "../foundation/index.js";
import type { HarnessId, RevisionSelector } from "../domain/index.js";
export type { RevisionSelector } from "../domain/index.js";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const COMMIT_PATTERN = /^[0-9a-fA-F]{7,64}$/;
const HARNESS_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface ParsedHarnessReference {
  raw: string;
  canonical: string;
  harness_id: HarnessId;
  selector: RevisionSelector;
}

export function parseHarnessReference(value: string): ParsedHarnessReference {
  if (typeof value !== "string" || !value.trim()) throw invalidInput("harness reference must be a non-empty string");
  const raw = value.trim();
  const separator = raw.indexOf("@");
  const harnessId = separator < 0 ? raw : raw.slice(0, separator);
  const revision = separator < 0 ? "installed" : raw.slice(separator + 1);
  if (!HARNESS_ID_PATTERN.test(harnessId)) throw invalidInput(`invalid harness name: ${harnessId || raw}`);
  if (!revision) throw invalidInput(`harness reference is missing a selector: ${raw}`);

  if (revision === "installed") {
    return canonicalReference(raw, harnessId as HarnessId, { type: "installed" });
  }
  if (revision.startsWith("version:")) {
    const version = revision.slice("version:".length);
    if (!VERSION_PATTERN.test(version)) {
      throw invalidInput(`version selector must be an exact semantic version: ${version || "(empty)"}`);
    }
    return canonicalReference(raw, harnessId as HarnessId, { type: "version", value: version });
  }
  if (revision.startsWith("commit:")) {
    const commit = revision.slice("commit:".length);
    assertCommit(commit);
    return canonicalReference(raw, harnessId as HarnessId, { type: "commit", value: commit.toLowerCase() });
  }
  if (revision.startsWith("git+")) {
    const hash = revision.lastIndexOf("#");
    if (hash < 0) throw invalidInput("explicit Git references require #<commit>");
    const sourceValue = revision.slice("git+".length, hash);
    const commit = revision.slice(hash + 1);
    assertCommit(commit);
    let source: URL;
    try {
      source = new URL(sourceValue);
    } catch (error) {
      throw invalidInput(`invalid Git source URL: ${sourceValue}`, { cause: error });
    }
    if (source.protocol !== "file:") {
      throw invalidInput("explicit Git sources are limited to file:// URLs; use the registered source for remote commits");
    }
    const localPath = path.resolve(fileURLToPath(source));
    if ([...localPath].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) {
      throw invalidInput("explicit Git source paths cannot contain control characters");
    }
    const sourceUrl = pathToFileURL(localPath).href;
    return canonicalReference(raw, harnessId as HarnessId, {
      type: "commit",
      value: commit.toLowerCase(),
      source: { type: "git", url: sourceUrl, local_path: localPath, explicit: true },
    });
  }

  throw invalidInput(`unsupported harness selector in ${raw}; use installed, version:<exact>, or commit:<sha>`);
}

/** Harbor can transport only an explicitly selected, exact object id. Local
 * resolution remains intentionally more permissive for ordinary host runs. */
export function assertExactLocalGitEvalReference(reference: ParsedHarnessReference): void {
  const selector = reference.selector;
  if (selector.type !== "commit" || !selector.source?.explicit) return;
  const hash = reference.raw.slice(reference.raw.lastIndexOf("#") + 1);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash)) {
    throw invalidInput("Harbor local Git eval requires a full lowercase 40- or 64-character commit OID");
  }
}

function canonicalReference(raw: string, harnessId: HarnessId, selector: RevisionSelector): ParsedHarnessReference {
  let suffix: string;
  if (selector.type === "installed") {
    suffix = "installed";
  } else if (selector.type === "commit" && selector.source) {
    suffix = `git+${selector.source.url}#${selector.value}`;
  } else {
    suffix = `${selector.type}:${selector.value}`;
  }
  return {
    raw,
    canonical: `${harnessId}@${suffix}`,
    harness_id: harnessId,
    selector,
  };
}

function assertCommit(value: string): void {
  if (!COMMIT_PATTERN.test(value || "")) {
    throw invalidInput(`commit selector must be a 7-64 character hexadecimal ID: ${value || "(empty)"}`);
  }
}

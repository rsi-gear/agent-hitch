import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import type { RevisionSourceDefinition } from "../../adapters/index.js";
import type { ResolvedRevision, RevisionSelector } from "../../domain/index.js";
import { HitchError, SCHEMA_VERSION, commandExecutable, digest, ensureDir, runCommand, withFileLock } from "../../foundation/index.js";
import type { StatePaths } from "../../foundation/index.js";
import type { ParsedHarnessReference } from "../reference.js";

export async function resolveCommit(reference: ParsedHarnessReference, source: RevisionSourceDefinition, paths: StatePaths, env: NodeJS.ProcessEnv): Promise<ResolvedRevision> {
  const selector = reference.selector as Extract<RevisionSelector, { type: "commit" }>;
  const sourceUrl = selector.source?.url || source.url;
  if (!sourceUrl) {
    throw new HitchError(`no Git source registered for ${reference.harness_id}`, {
      code: "revision_selector_unsupported",
      exitCode: 10,
    });
  }
  const localPath = selector.source?.local_path;
  const git = commandExecutable("git", env);
  let fullCommit: string | undefined;
  if (localPath) {
    const statusResult = await runCommand(git, ["-C", localPath, "status", "--porcelain"], {
      env,
      failureCode: "resolution_failed",
      failureExitCode: 4,
    });
    if (statusResult.stdout.trim()) {
      throw new HitchError(`local harness repository has uncommitted changes: ${localPath}`, {
        code: "dirty_source",
        exitCode: 11,
      });
    }
    fullCommit = await revParseCommit(git, localPath, selector.value, env);
  }

  const cacheDirectory = gitCacheDirectory(paths, sourceUrl);
  const requestedCommit = fullCommit || selector.value;
  fullCommit = await withFileLock(paths.sourceLocks, digest(sourceUrl), async () => {
    await ensureGitCache(git, cacheDirectory, sourceUrl, env);
    if (requestedCommit.length >= 40) {
      await fetchCommit(git, cacheDirectory, sourceUrl, requestedCommit, env);
    } else {
      await fetchAdvertisedRefs(git, cacheDirectory, sourceUrl, env);
    }
    return revParseBareCommit(git, cacheDirectory, requestedCommit, env);
  }, { timeoutCode: "resolution_locked", timeoutExitCode: 4 });
  const normalizedSource = sanitizeUrl(sourceUrl);
  const identity = digest({
    harness_id: reference.harness_id,
    source_type: "git",
    source: normalizedSource,
    commit: fullCommit,
  });
  return {
    schema_version: SCHEMA_VERSION,
    requested_ref: reference.raw,
    canonical_ref: reference.canonical,
    harness_id: reference.harness_id,
    selector: { type: "commit", value: selector.value },
    source: {
      type: "git",
      url: normalizedSource,
      registered: !selector.source?.explicit,
    },
    revision: {
      type: "commit",
      requested_commit: selector.value,
      commit: fullCommit,
    },
    identity,
    resolved_at: new Date().toISOString(),
  };
}

async function ensureGitCache(git: string, directory: string, sourceUrl: string, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    await access(path.join(directory, "HEAD"));
    try {
      await runCommand(git, ["--git-dir", directory, "remote", "set-url", "origin", sourceUrl], {
        env,
        failureCode: "resolution_failed",
        failureExitCode: 4,
      });
    } catch {
      await runCommand(git, ["--git-dir", directory, "remote", "add", "origin", sourceUrl], {
        env,
        failureCode: "resolution_failed",
        failureExitCode: 4,
      });
    }
    return;
  } catch (error) {
    if (error instanceof HitchError) throw error;
  }
  await ensureDir(path.dirname(directory));
  await runCommand(git, ["init", "--bare", directory], {
    env,
    failureCode: "resolution_failed",
    failureExitCode: 4,
  });
  await runCommand(git, ["--git-dir", directory, "remote", "add", "origin", sourceUrl], {
    env,
    failureCode: "resolution_failed",
    failureExitCode: 4,
  });
}

async function fetchCommit(git: string, cacheDirectory: string, sourceUrl: string, commit: string, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    await runCommand(git, ["--git-dir", cacheDirectory, "fetch", "--no-tags", "origin", commit], {
      env,
      failureCode: "revision_not_found",
      failureExitCode: 3,
    });
  } catch {
    await fetchAdvertisedRefs(git, cacheDirectory, sourceUrl, env);
  }
}

async function fetchAdvertisedRefs(git: string, cacheDirectory: string, _sourceUrl: string, env: NodeJS.ProcessEnv): Promise<void> {
  await runCommand(git, [
    "--git-dir", cacheDirectory,
    "fetch", "--force", "origin",
    "+refs/heads/*:refs/remotes/origin/*",
    "+refs/tags/*:refs/tags/*",
  ], {
    env,
    failureCode: "resolution_failed",
    failureExitCode: 4,
  });
}

async function revParseCommit(git: string, directory: string, commit: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const result = await runCommand(git, ["-C", directory, "rev-parse", "--verify", `${commit}^{commit}`], {
      env,
      failureCode: "revision_not_found",
      failureExitCode: 3,
    });
    return result.stdout.trim().toLowerCase();
  } catch (error) {
    throw new HitchError(`revision not found or ambiguous: ${commit}`, {
      code: "revision_not_found",
      exitCode: 3,
      cause: error,
    });
  }
}

async function revParseBareCommit(git: string, directory: string, commit: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const result = await runCommand(git, ["--git-dir", directory, "rev-parse", "--verify", `${commit}^{commit}`], {
      env,
      failureCode: "revision_not_found",
      failureExitCode: 3,
    });
    return result.stdout.trim().toLowerCase();
  } catch (error) {
    throw new HitchError(`revision not found or ambiguous: ${commit}`, {
      code: "revision_not_found",
      exitCode: 3,
      cause: error,
    });
  }
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return value;
  }
}

export function gitCacheDirectory(paths: StatePaths, sourceUrl: string): string {
  const key = createHash("sha256").update(sourceUrl).digest("hex");
  return path.join(paths.sourceCache, `git-${key}`);
}

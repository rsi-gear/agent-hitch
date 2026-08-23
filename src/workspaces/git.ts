import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { HitchError, terminateProcess } from "../foundation/index.js";
import { withWorkspaceLock } from "./store.js";
import type { GitWorkspaceInfo, WorkspacePlan, WorktreePreparation } from "./types.js";
import { COMMAND_TIMEOUT_MS } from "./types.js";
import { cancelledError, canonicalizePotentialPath, pathExists, throwIfAborted } from "./utils.js";

export async function prepareWorktree(plan: WorkspacePlan, { signal }: { signal?: AbortSignal | undefined }): Promise<WorktreePreparation | undefined> {
  await withWorkspaceLock(plan.state_root, plan.git?.common_dir as string, async () => {
    await runGit([
      "-C",
      plan.git?.repository_root as string,
      "worktree",
      "add",
      "--detach",
      plan.execution_root,
      plan.git?.head as string,
    ], {
      signal,
      env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" },
      failureCode: "workspace_provision_failed",
      failureExitCode: 5,
    });
  }, { signal });
  if (!await pathExists(plan.execution_workspace)) {
    throw new HitchError(`workspace subdirectory does not exist at commit ${plan.git?.head}: ${plan.source_subdirectory}`, {
      code: "workspace_subdirectory_missing",
      exitCode: 2,
    });
  }
  return undefined;
}

export async function inspectGitWorkspace(directory: string, { required }: { required: boolean }): Promise<GitWorkspaceInfo | null> {
  const rootOutput = await tryGitOutput(["-C", directory, "rev-parse", "--show-toplevel"]);
  if (rootOutput === null) {
    if (required) {
      throw new HitchError("worktree isolation requires a Git workspace", {
        code: "workspace_not_git",
        exitCode: 2,
      });
    }
    return null;
  }
  const repositoryRoot = await realpath(rootOutput);
  const [head, commonDirOutput, statusOutput] = await Promise.all([
    tryGitOutput(["-C", repositoryRoot, "rev-parse", "--verify", "HEAD^{commit}"]),
    runGit(["-C", repositoryRoot, "rev-parse", "--git-common-dir"], {
      failureCode: "workspace_git_invalid",
      failureExitCode: 2,
    }).then((result) => result.stdout.trim()),
    runGit(["-C", repositoryRoot, "status", "--porcelain=v1", "--untracked-files=all"], {
      failureCode: "workspace_git_invalid",
      failureExitCode: 2,
    }).then((result) => result.stdout.trim()),
  ]);
  if (required && !head) {
    throw new HitchError("worktree isolation requires a Git workspace with at least one commit", {
      code: "workspace_git_no_commit",
      exitCode: 2,
    });
  }
  const commonDir = await realpath(path.resolve(repositoryRoot, commonDirOutput));
  return {
    repository_root: repositoryRoot,
    common_dir: commonDir,
    head,
    status: statusOutput,
  };
}

export async function isolatedGitMetadataDigest(directory: string, { signal }: { signal?: AbortSignal | undefined } = {}): Promise<string> {
  const [head, statusOutput, refs, config] = await Promise.all([
    runGit(["-C", directory, "rev-parse", "--verify", "HEAD^{commit}"], {
      signal,
      failureCode: "workspace_git_invalid",
      failureExitCode: 12,
    }).then((result) => result.stdout, () => ""),
    runGit(["-C", directory, "status", "--porcelain=v1", "--untracked-files=all"], {
      signal,
      failureCode: "workspace_git_invalid",
      failureExitCode: 12,
    }).then((result) => result.stdout),
    runGit(["-C", directory, "for-each-ref", "--format=%(refname)%00%(objectname)"], {
      signal,
      failureCode: "workspace_git_invalid",
      failureExitCode: 12,
    }).then((result) => result.stdout),
    runGit(["-C", directory, "config", "--local", "--null", "--list"], {
      signal,
      failureCode: "workspace_git_invalid",
      failureExitCode: 12,
    }).then((result) => result.stdout),
  ]);
  return `sha256:${createHash("sha256").update(JSON.stringify({ head, status: statusOutput, refs, config })).digest("hex")}`;
}

export async function registeredWorktree(commonDirectory: string, candidate: string): Promise<boolean> {
  const result = await runGit(["--git-dir", commonDirectory, "worktree", "list", "--porcelain"], {
    failureCode: "workspace_cleanup_failed",
    failureExitCode: 12,
  });
  const candidatePath = await canonicalizePotentialPath(candidate);
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.startsWith("worktree ")) continue;
    const registeredPath = await canonicalizePotentialPath(line.slice("worktree ".length));
    if (path.resolve(registeredPath) === path.resolve(candidatePath)) return true;
  }
  return false;
}

interface GitCommandResult {
  stdout: string;
  stderr: string;
}

interface GitCommandOptions {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal | undefined;
  failureCode?: string;
  failureExitCode?: number;
  timeoutMs?: number;
}

export async function runGit(args: string[], options: GitCommandOptions = {}): Promise<GitCommandResult> {
  return runCommand(process.env.HITCH_GIT_PATH?.trim() || "git", args, options);
}

export async function tryGitOutput(args: string[]): Promise<string | null> {
  try {
    return (await runGit(args)).stdout.trim();
  } catch {
    return null;
  }
}

async function runCommand(executable: string, args: string[], {
  env = process.env,
  signal,
  failureCode = "workspace_provision_failed",
  failureExitCode = 5,
  timeoutMs = COMMAND_TIMEOUT_MS,
}: GitCommandOptions = {}): Promise<GitCommandResult> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let aborted = false;
    const append = (current: string, chunk: Buffer | string) => `${current}${chunk}`.slice(-1_000_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
      callback();
    };
    const abortHandler = () => {
      aborted = true;
      terminateProcess(child).catch(() => {});
    };
    const timer = setTimeout(() => terminateProcess(child).catch(() => {}), timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", abortHandler, { once: true });
    child.once("error", (error: Error) => finish(() => reject(new HitchError(
      `failed to start ${path.basename(executable)}: ${error.message}`,
      { code: failureCode, exitCode: failureExitCode, cause: error },
    ))));
    child.once("close", (code: number | null, processSignal: NodeJS.Signals | null) => {
      if (aborted) return finish(() => reject(cancelledError()));
      if (code === 0) return finish(() => resolve({ stdout, stderr }));
      const detail = stderr.trim() || stdout.trim();
      finish(() => reject(new HitchError(
        `${path.basename(executable)} exited with code ${code ?? "null"}${processSignal ? ` (${processSignal})` : ""}${detail ? `: ${detail}` : ""}`,
        { code: failureCode, exitCode: failureExitCode },
      )));
    });
  });
}

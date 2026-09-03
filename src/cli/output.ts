import { HitchError, delay } from "../foundation/index.js";

export function revisionLabel(resolved: { revision: { type: string; version?: string | null; commit?: string }; source: { integrity?: string } }): string {
  if (resolved.revision.type === "commit") return resolved.revision.commit || "";
  if (resolved.revision.type === "version") return resolved.revision.version || "";
  return resolved.revision.version || resolved.source.integrity || "";
}

export async function waitForDaemonRun(client: { request: (pathname: string, options?: RequestInit) => Promise<Record<string, unknown>>; requestWithMetadata: (pathname: string, options?: RequestInit) => Promise<{ payload: Record<string, unknown> | string; headers: Headers }> }, runId: string, output: string): Promise<Record<string, unknown>> {
  let eventOffset = 0;
  for (;;) {
    const status = await client.request(`/v1/runs/${runId}`);
    if (output === "jsonl") {
      try {
        const response = await client.requestWithMetadata(`/v1/runs/${runId}/events?offset=${eventOffset}`);
        const raw = response.payload;
        for (const line of String(raw).trim().split(/\r?\n/).filter(Boolean)) {
          JSON.parse(line);
          process.stdout.write(`${line}\n`);
        }
        eventOffset = Number(response.headers.get("x-hitch-next-offset") || eventOffset);
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
      }
    }
    if (status.result) {
      if (output === "json") process.stdout.write(`${JSON.stringify(status.result, null, 2)}\n`);
      return status.result as Record<string, unknown>;
    }
    await delay(200);
  }
}

export async function waitForDaemonEval(client: { request: (pathname: string, options?: RequestInit) => Promise<Record<string, unknown>>; requestWithMetadata: (pathname: string, options?: RequestInit) => Promise<{ payload: Record<string, unknown> | string; headers: Headers }> }, evalId: string, output: string): Promise<Record<string, unknown>> {
  let eventOffset = 0;
  for (;;) {
    const status = await client.request(`/v1/evals/${evalId}`);
    if (output === "jsonl") {
      try {
        const response = await client.requestWithMetadata(`/v1/evals/${evalId}/events?offset=${eventOffset}`);
        for (const line of String(response.payload).trim().split(/\r?\n/).filter(Boolean)) {
          JSON.parse(line);
          process.stdout.write(`${line}\n`);
        }
        eventOffset = Number(response.headers.get("x-hitch-next-offset") || eventOffset);
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
      }
    }
    if (status.result) {
      if (output === "json") process.stdout.write(`${JSON.stringify(status.result, null, 2)}\n`);
      return status.result as Record<string, unknown>;
    }
    await delay(200);
  }
}

export async function waitForDaemonEvalRerun(client: { request: (pathname: string, options?: RequestInit) => Promise<Record<string, unknown>> }, evalId: string, rerunId: string): Promise<Record<string, unknown>> {
  for (;;) {
    const status = await client.request(`/v1/evals/${evalId}/reruns/${rerunId}`);
    if (status.result && (status.state as { status?: string })?.status === "completed") {
      process.stdout.write(`${JSON.stringify(status.result, null, 2)}\n`);
      return status.result as Record<string, unknown>;
    }
    const state = status.state as { status?: unknown; error?: { code?: unknown; message?: unknown } } | undefined;
    if (state?.status === "failed" || state?.status === "cancelled") {
      throw new HitchError(typeof state.error?.message === "string" ? state.error.message : "eval rerun failed", {
        code: typeof state.error?.code === "string" ? state.error.code : "eval_rerun_failed",
        exitCode: 12,
      });
    }
    await delay(200);
  }
}

export function helpText(): string {
  return `Hitch — content-addressed version control and evidence storage for agent harnesses

Usage:
  hitch list [--json]
  hitch inspect <harness> [--json]
  hitch resolve <harness-ref> [--json]
  hitch prepare <harness-ref> [--json]
  hitch run --harness <ref> [--model <id>] [--context-file <json>] [--workspace-mode <mode>] --prompt <text> [--daemon]
  hitch runs list [filters] [--json]
  hitch runs inspect <run-id> [--json]
  hitch runs rebuild-index [--json]
  hitch runs candidate <run-id> [--context-license allowed|denied|unknown] [--capture-required] [--json]
  hitch compare model|harness [filters] [--reference-run <run-id>] [--json]
  hitch eval setup harbor [--version <version>] [--python <path>] [--force] [--json]
  hitch eval doctor [--harbor <path>] [--python <path>] [--docker <path>] [--json]
  hitch eval run [--backend harbor] --dataset <ref> --harness <immutable-ref> [--model <id>] [--attempts <n>] [--infrastructure-retries <n>] [--eval-id <eval-id>] [--daemon] [--idempotency-key <key>] [execution policy]
  hitch benchmark validate --package <directory>
  hitch benchmark lock --package <directory> [--out <benchmark.lock.json>]
  hitch eval run --benchmark <directory> | --benchmark-lock <file> --harness <immutable-ref> [--model <id>]
  hitch eval submit [--backend harbor] --dataset <ref> --harness <immutable-ref> [--model <id>] [--idempotency-key <key>] [execution policy]
    execution policy: [--provider <id>] [--cpu-per-trial <integer-cpus>] [--memory-per-trial <size>]
      [--build-mode backend|prebuild-preferred|prebuild-required]
      [--model-capture off|native|proxy|hybrid] [--require-model-capture]
  hitch eval watch <eval-id> [--output json|jsonl]
  hitch eval cancel <eval-id>
  hitch eval rerun <eval-id> (--invalid | --task <name> [--task <name> ...]) [--type <type>] [--verifier-runtime <sha256:id>] [--daemon] [--rerun-id <id>] [--output json]
  hitch eval rerun-cancel <eval-id> <rerun-id>
  hitch eval list [--json]
  hitch eval inspect <eval-id> [--json]
  hitch workspace inspect <run-id> [--json]
  hitch workspace path <run-id>
  hitch workspace remove <run-id> [--force] [--json]
  hitch images gc [--minimum-age <duration>] [--apply] [--json]
  hitch images pin <sha256:image-id> [--reason <text>]
  hitch images unpin <sha256:image-id>
  hitch trajectory inspect <run-id> [--json]
  hitch feedback list <run-id> [--json]
  hitch feedback put <run-id> --message <id> --rating positive|negative [--note <text>] [--if-version <v>] [--json]
  hitch feedback delete <run-id> --message <id> [--if-version <v>] [--json]
  hitch daemon start [--foreground] [--port <port>] [--max-concurrent <n>]
    [--capacity-cpu-millis <n>] [--capacity-memory-mib <n>]
    [--container-slots <n>] [--build-slots <n>]
    [--capacity-gpus <n>] [--eval-gpus <n>]
    [--capacity-ephemeral-disk-mib <n>] [--eval-ephemeral-disk-mib <n>]
    [--run-cpu-millis <n>] [--run-memory-mib <n>]
    [--eval-cpu-millis <n>] [--eval-memory-mib <n>]
  hitch daemon stop | status [--json] | logs [-n <lines>]
  hitch daemon submit --harness <ref> --prompt <text> [--workspace-mode <mode>] [--wait]
  hitch daemon cancel <run-id>
  hitch worker register --server <url> --registration <json> --admin-token-file <file> --credential-file <file>
  hitch worker run --server <url> --registration <json> --credential-file <file> [--harbor <path>] [--docker <path>] [--once]

Eval:
  Harbor runs each task in Docker; Hitch executes the selected harness inside that task container.
  Rerun type candidate-restart is supported and is the compatibility default.
  collect-only imports an already-finished Harbor result without executing Candidate. candidate-resume, trajectory-replay, and verifier-only fail explicitly until their recovery prerequisites exist.
  Use 'hitch eval setup harbor' for an isolated managed install and 'hitch eval doctor' to verify it.
  Eval accepts exact version:, registered commit:, or full lowercase local git+file commit refs.
  Local Git evals transport only committed Git objects; the source repository must be clean.
  Use --pass-env NAME for extra credentials.
  Every eval references a shared read-only controller runtime bundle by SHA-256 id
  (see 'hitch eval inspect' for the runtime storage kind).
  Eval attempts are stable logical task/attempt slots; rerun repairs only invalid or missing slots.
  Verifier infrastructure failures are retried once by default; use --infrastructure-retries 0 to disable.
  --task selects every invalid or missing attempt for the named task.

Trajectory and feedback:
  Structured adapters preserve provider-native events plus a DSH-compatible canonical view
  under runs/<run>/trajectory/, bound by trajectory.ref.json V2 checksums.
  Message feedback is a lifecycle-bound sidecar.

Workspace modes:
  shared    Use the source directory directly (compatibility default)
  worktree  Create a detached worktree from a clean Git HEAD
  copy      Copy the current filesystem state into an independent workspace

Harness refs:
  codex                         Installed executable (compatibility default)
  codex@installed               Installed executable
  codex@version:0.42.1          Exact published version
  codex@commit:abc1234          Commit from the registered Git source
  codex@git+file:///src#abc1234 Commit from a clean local Git repository

Global:
  --root <path>    Relocate all Hitch state (default: ~/.hitch)

Remote workers:
  Use a dedicated --root on each worker host. Registration rotates the worker credential and writes it with mode 0600.
  The worker downloads content-addressed inputs before accepting a lease, runs Harbor with the same evidence contract, and waits for an explicit release request before cleanup.
`;
}

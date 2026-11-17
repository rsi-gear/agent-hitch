import { access, chmod, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { invalidInput, atomicWriteJSON } from "../foundation/index.js";
import { HostModelProxy } from "../model-access/index.js";
import type { GenerationLimits } from "../model-access/index.js";
import type { ProcessSpecification } from "../adapters/index.js";

import type { RunIsolation } from "../domain/index.js";
export type { RunIsolation } from "../domain/index.js";
export function parseRunIsolation(value: unknown): RunIsolation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput("isolation must be an object");
  const r = value as Record<string, unknown>;
  const keys = ["read_paths", "write_paths", "unix_sockets", "allowed_domains", "linux_isolation", "output_schema", "output_file", "reasoning_effort", "executable_sha256"];
  if (Object.keys(r).some(key => !keys.includes(key))) throw invalidInput("unknown isolation option");
  if (r.executable_sha256 !== undefined && (typeof r.executable_sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(r.executable_sha256))) throw invalidInput("invalid isolated executable digest");
  for (const key of ["read_paths", "write_paths", "unix_sockets"]) {
    if (!Array.isArray(r[key]) || r[key].some(p => typeof p !== "string" || !path.isAbsolute(p) || p.includes("\0"))) throw invalidInput(`invalid isolation ${key}`);
  }
  if (!Array.isArray(r.allowed_domains) || r.allowed_domains.some(d => typeof d !== "string" || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(d)))
    throw invalidInput("isolation allowed_domains must contain exact domains");
  if (r.linux_isolation !== undefined && !["seccomp", "bubblewrap-only"].includes(String(r.linux_isolation))) throw invalidInput("invalid Linux isolation");
  if (r.reasoning_effort !== undefined && !["minimal", "low", "medium", "high", "xhigh", "max"].includes(String(r.reasoning_effort))) throw invalidInput("invalid reasoning effort");
  for (const key of ["output_schema", "output_file"]) if (r[key] !== undefined && (typeof r[key] !== "string" || !path.isAbsolute(r[key] as string))) throw invalidInput(`invalid ${key}`);
  return r as unknown as RunIsolation;
}

export async function canonicalRunIsolation(value: unknown): Promise<RunIsolation> {
  const policy = parseRunIsolation(value);
  return { ...policy,
    read_paths: await Promise.all(policy.read_paths.map(p => realpath(p))),
    write_paths: await Promise.all(policy.write_paths.map(p => realpath(p))),
    unix_sockets: await Promise.all(policy.unix_sockets.map(p => realpath(p))),
    ...(policy.output_schema ? { output_schema: await realpath(policy.output_schema) } : {}),
    ...(policy.output_file ? { output_file: path.join(await realpath(path.dirname(policy.output_file)), path.basename(policy.output_file)) } : {}),
  };
}

async function credentials(domains: string[]) {
  let apiKey = process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY;
  let account = "", token = "";
  if (!apiKey) {
    const authHome = process.env.HITCH_CODEX_AUTH_HOME;
    if (!authHome || !path.isAbsolute(authHome)) throw invalidInput("isolated Codex requires an API key or HITCH_CODEX_AUTH_HOME");
    const file = await open(path.join(authHome, "auth.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    let auth: Record<string, unknown>;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) throw invalidInput("invalid Codex auth file");
      auth = JSON.parse((await file.readFile()).toString("utf8"));
    } finally { await file.close(); }
    if (typeof auth.OPENAI_API_KEY === "string") apiKey = auth.OPENAI_API_KEY;
    else {
      const tokens = auth.tokens as Record<string, unknown> | undefined;
      if (typeof tokens?.access_token !== "string" || typeof tokens.account_id !== "string") throw invalidInput("invalid Codex login");
      token = tokens.access_token; account = tokens.account_id;
    }
  }
  const host = apiKey ? "api.openai.com" : "chatgpt.com";
  if (!domains.includes(host)) throw invalidInput("model service is outside isolation allowed_domains");
  return { base: apiKey ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api/codex",
    authorization: `Bearer ${apiKey || token}`,
    headers: apiKey ? {} : { "ChatGPT-Account-Id": account, originator: "codex_cli_rs" },
    secrets: [apiKey || token, ...(account ? [account] : [])] };
}

const systemPaths = () => process.platform === "darwin"
  ? ["/System", "/usr", "/bin", "/sbin", "/Library", "/etc", "/private/etc", "/dev"]
  : ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/dev"];
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
// SandboxManager is process-scoped. Isolated runs use a dedicated CLI worker.
let inUse = false;

export async function prepareRunIsolation(input: {
  root: string; runId: string; model: string; isolation: RunIsolation; limits?: GenerationLimits;
}) {
  if (inUse) throw invalidInput("isolated agent runs require separate worker processes");
  inUse = true;
  let proxy: HostModelProxy | undefined, home: string | undefined;
  const close = async () => {
    try {
      await proxy?.close();
      if (proxy) {
        await proxy.finalizeRun(input.runId, path.join(input.root, "runs", input.runId));
        await atomicWriteJSON(path.join(input.root, "runs", input.runId, "generation-budget.json"), proxy.generationBudget!.audit());
      }
    } finally {
      await SandboxManager.reset();
      if (home) await rm(home, { recursive: true, force: true });
      inUse = false;
    }
  };
  try {
    const auth = await credentials(input.isolation.allowed_domains);
    const upstreamProxyEnv = Object.fromEntries(["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []));
    const proxySecrets = Object.values(upstreamProxyEnv).flatMap(value => {
      try { const url = new URL(value); return url.username || url.password ? [value, decodeURIComponent(url.username), decodeURIComponent(url.password)] : []; }
      catch { return []; }
    }).filter(Boolean);
    auth.secrets.push(...proxySecrets);
    home = await mkdtemp(path.join(await realpath(tmpdir()), "hitch-agent-"));
    await chmod(home, 0o700);
    const proxyOrigin = "http://hitch-model.invalid";
    proxy = await HostModelProxy.start({
      captureRoot: path.join(input.root, "private", "run-model-capture", input.runId), evalId: `eval_${input.runId.slice(4)}`,
      mode: "proxy", required: true, advertisedHost: "127.0.0.1",
      upstreams: { openai: auth.base }, upstreamAuthorizations: { openai: auth.authorization }, upstreamHeaders: { openai: auth.headers },
      upstreamWireModels: { openai: input.model }, credentialValues: auth.secrets,
      generationLimits: input.limits ?? {}, forwardProxyOrigin: proxyOrigin,
      upstreamProxyEnv,
      onRun: async id => { if (id !== input.runId) throw invalidInput("model request belongs to another run"); },
    });
    const identity = proxy.runtimeIdentity();
    const providerUrl = `${proxyOrigin}/${identity.capabilityToken}/${input.runId}/openai`;
    return {
      credentials: auth.secrets,
      runtime: { isolated: { ...input.isolation, provider_url: providerUrl } },
      usage: () => proxy!.generationBudget!.usage(),
      error: () => proxy!.generationBudget!.error(),
      close,
      wrap: async (specification: ProcessSpecification, cwd: string, timeoutMs: number) => {
        const executable = await realpath(specification.executable);
        if (input.isolation.executable_sha256) {
          const digest = createHash("sha256");
          for await (const bytes of createReadStream(executable)) digest.update(bytes);
          if (`sha256:${digest.digest("hex")}` !== input.isolation.executable_sha256) throw invalidInput("isolated executable changed after admission");
        }
        const companion = path.join(path.dirname(executable), "codex-code-mode-host");
        const companionPaths = await access(companion, constants.X_OK).then(() => [companion]).catch(() => []);
        const weaker = process.platform === "linux" && input.isolation.linux_isolation === "bubblewrap-only";
        let seccomp: string | undefined;
        if (process.platform === "linux" && !weaker) {
          if (!["x64", "arm64"].includes(process.arch)) throw invalidInput("unsupported seccomp architecture");
          const entry = fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime"));
          seccomp = await realpath(path.resolve(path.dirname(entry), "..", "vendor", "seccomp", process.arch, "apply-seccomp"));
          await access(seccomp, constants.X_OK);
        }
        const config: SandboxRuntimeConfig = {
          network: { allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true,
            httpProxyPort: identity.listenPort, allowUnixSockets: input.isolation.unix_sockets,
            allowAllUnixSockets: weaker, allowLocalBinding: false },
          filesystem: { denyRead: ["/"], allowRead: [...systemPaths(), executable, ...companionPaths, ...input.isolation.read_paths, home!, ...(seccomp ? [seccomp] : [])],
            allowWrite: [...input.isolation.write_paths, home!], denyWrite: [], allowGitConfig: false },
          ...(seccomp ? { seccomp: { applyPath: seccomp } } : {}), allowAppleEvents: false,
        };
        await SandboxManager.initialize(config); await SandboxManager.waitForNetworkInitialization();
        if (process.platform === "linux") config.filesystem.allowRead!.push(...[
          SandboxManager.getLinuxHttpSocketPath(), SandboxManager.getLinuxSocksSocketPath(),
        ].filter((socket): socket is string => socket !== undefined));
        const wrapped = await SandboxManager.wrapWithSandboxArgv([executable, ...specification.args].map(quote).join(" "), "/bin/bash", config);
        const certificates = process.platform === "darwin" ? await realpath("/etc/ssl/cert.pem") : undefined;
        return {
          executable: process.env.HITCH_GUARD_PYTHON || "python3",
          args: ["-I", "-B", fileURLToPath(new URL("../../../integrations/isolated-run/process-guard.py", import.meta.url))],
          input: JSON.stringify({ argv: wrapped.argv, cwd, prompt: specification.input,
            cleanupRoot: home, timeoutMs,
            env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: home, CODEX_HOME: home, TMPDIR: home,
              HITCH_ISOLATED_MODEL_KEY: "hitch-budget-gateway", ...(certificates ? { CODEX_CA_CERTIFICATE: certificates, SSL_CERT_FILE: certificates } : {}) } }) + "\n",
        };
      },
    };
  } catch (error) { await close().catch(() => {}); throw error; }
}

/** fd 3 belongs only to the guard, never to the untrusted agent. */
export function watchGuard(child: import("node:child_process").ChildProcess) {
  let confirmation = "";
  child.stdio[3]?.on("data", (chunk: Buffer) => { if (Buffer.byteLength(confirmation) <= 1024) confirmation += chunk.toString("utf8"); });
  return (exit: { code: number | null; signal: NodeJS.Signals | null }): boolean => {
    try { const ack = JSON.parse(confirmation); return !exit.signal && ack.version === 1 && ack.model_stopped === true && ack.returncode === exit.code; }
    catch { return false; }
  };
}

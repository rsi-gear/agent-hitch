import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { HitchError, invalidInput } from "../../foundation/index.js";

export const HOST_CREDENTIAL_HELPER_ENV = "HITCH_HOST_CREDENTIAL_HELPER_JSON";
export const HOST_CREDENTIAL_HELPER_CAPABILITY = "host-task-credential-helper-v1";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_ARGUMENTS = 32;
const MAX_ARGUMENT_LENGTH = 4_096;

export interface HostCredentialHelperConfig {
  argv: string[];
  credentialNames: string[];
  timeoutMs: number;
}

export function parseHostCredentialHelperConfig(env: NodeJS.ProcessEnv): HostCredentialHelperConfig | null {
  const encoded = env[HOST_CREDENTIAL_HELPER_ENV];
  if (encoded === undefined) return null;
  if (!encoded || Buffer.byteLength(encoded) > MAX_CONFIG_BYTES) throw invalidConfiguration();

  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw invalidConfiguration();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidConfiguration();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "argv,credentialNames,timeoutMs,version") throw invalidConfiguration();
  if (record.version !== 1) throw invalidConfiguration();

  if (!Array.isArray(record.argv) || record.argv.length < 1 || record.argv.length > MAX_ARGUMENTS
    || record.argv.some((entry) => typeof entry !== "string" || !entry || entry.length > MAX_ARGUMENT_LENGTH || /[\0\r\n]/.test(entry))) {
    throw invalidConfiguration();
  }
  const argv = [...record.argv] as string[];
  if (!path.isAbsolute(argv[0] as string)) throw invalidConfiguration();

  if (!Array.isArray(record.credentialNames) || record.credentialNames.length < 1
    || record.credentialNames.some((entry) => typeof entry !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry))) {
    throw invalidConfiguration();
  }
  const credentialNames = [...record.credentialNames] as string[];
  if (new Set(credentialNames).size !== credentialNames.length) throw invalidConfiguration();

  if (!Number.isSafeInteger(record.timeoutMs) || (record.timeoutMs as number) < 100 || (record.timeoutMs as number) > 60_000) {
    throw invalidConfiguration();
  }
  return { argv, credentialNames: credentialNames.sort(), timeoutMs: record.timeoutMs as number };
}

export function helperCredentialNamesForRequest(
  config: HostCredentialHelperConfig | null,
  passEnv: readonly string[],
): string[] {
  if (config === null) return [];
  const requested = new Set(passEnv);
  if (config.credentialNames.some((name) => !requested.has(name))) {
    throw invalidInput("host credential helper names must be explicitly requested with --pass-env");
  }
  return [...config.credentialNames];
}

export function withHostCredentialPlaceholders(env: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  if (names.length === 0) return env;
  const result = { ...env };
  for (const name of names) result[name] = "";
  return result;
}

export async function assertHostCredentialRuntimeSupport(runtimeDirectory: string): Promise<void> {
  const modules = ["hitch_host_credentials.py", "hitch_private_exec.py"];
  try {
    await Promise.all(modules.map((name) => access(
      path.join(runtimeDirectory, "payload", "integrations", "harbor", name),
      constants.R_OK,
    )));
  } catch {
    throw new HitchError("the selected controller runtime does not support host task credentials", {
      code: "host_credential_helper_runtime_unsupported",
      exitCode: 3,
    });
  }
}

function invalidConfiguration(): Error {
  return invalidInput(`${HOST_CREDENTIAL_HELPER_ENV} is invalid`);
}

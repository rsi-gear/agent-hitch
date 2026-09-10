import { readFile } from "node:fs/promises";
import type { RemoteWorkerHostIdentityV1 } from "../domain/index.js";
import { HitchError, runCommand, sha256JSON } from "../foundation/index.js";

/** Observe locally, with fixed commands. Raw hardware and machine identifiers never leave this module. */
export async function observeRemoteWorkerHost(): Promise<RemoteWorkerHostIdentityV1> {
  const platform = process.platform;
  let machine: string, boot: string;
  if (platform === "linux") {
    machine = (await readFile("/etc/machine-id", "utf8")).trim().toLowerCase();
    boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(machine) || /^0+$/.test(machine) || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(boot)) throw unavailable();
  } else if (platform === "darwin") {
    const options = { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeoutMs: 5_000 };
    const hardware = await runCommand("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], options);
    const matches = [...hardware.stdout.matchAll(/"IOPlatformUUID"\s*=\s*"([a-f0-9-]{36})"/gi)];
    if (matches.length !== 1) throw unavailable();
    machine = matches[0]![1]!.toLowerCase();
    boot = (await runCommand("/usr/sbin/sysctl", ["-n", "kern.boottime"], options)).stdout.trim();
    if (!/^\{ sec = \d+, usec = \d+ \}/.test(boot)) throw unavailable();
    // sysctl also prints a timezone-dependent date. Only kernel seconds/useconds define the boot.
    boot = boot.match(/^\{ sec = \d+, usec = \d+ \}/)![0];
  } else throw unavailable();
  return { schema_version: "1", platform, host_id: sha256JSON({ platform, machine }), boot_id: sha256JSON({ platform, boot }) };
}

function unavailable(): HitchError {
  return new HitchError("worker recovery requires an observable stable host and boot identity", { code: "remote_worker_cleanup_ambiguous", exitCode: 12 });
}

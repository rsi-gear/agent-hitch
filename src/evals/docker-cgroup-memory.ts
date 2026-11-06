import { readFile } from "node:fs/promises";
import path from "node:path";

/** Read the host kernel counter only when /proc proves this PID belongs to
 * this exact container. Remote/VM daemons usually have no matching host PID.
 * Each read opens a new FD; this observer never writes/reset memory.peak. */
export async function readDockerCgroupMemoryPeak(containerId: string, pid: number): Promise<number | undefined> {
  if (process.platform !== "linux" || !/^[a-f0-9]{64}$/.test(containerId) || !Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    const proc = `/proc/${pid}/cgroup`;
    const before = await readFile(proc, "utf8");
    const cgroup = before.split("\n").find(line => line.startsWith("0::/"))?.slice(3);
    if (!cgroup || !cgroup.includes(containerId) || cgroup.includes("..") || /[\0\r\n]/.test(cgroup)) return undefined;
    const raw = (await readFile(path.join("/sys/fs/cgroup", cgroup, "memory.peak"), "utf8")).trim();
    if (!/^\d+$/.test(raw) || await readFile(proc, "utf8") !== before) return undefined;
    const peak = Number(raw);
    return Number.isSafeInteger(peak) ? peak : undefined;
  } catch { return undefined; }
}

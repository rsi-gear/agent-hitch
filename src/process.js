import { spawn } from "node:child_process";
import { once } from "node:events";

export async function terminateProcess(child, graceMs = 3_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await Promise.race([once(killer, "exit"), delay(graceMs)]);
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    return;
  }

  await Promise.race([once(child, "exit"), delay(graceMs)]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

export function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

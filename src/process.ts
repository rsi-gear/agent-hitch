import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export async function terminateProcess(child: ChildProcess | null | undefined, graceMs = 3_000): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await waitForExitOrTimeout(killer, graceMs);
    return;
  }

  try {
    process.kill(-(child.pid as number), "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") throw error;
    return;
  }

  await waitForExitOrTimeout(child, graceMs);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-(child.pid as number), "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") throw error;
    }
  }
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForExitOrTimeout(child: ChildProcess, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    child.once("exit", finish);
  });
}

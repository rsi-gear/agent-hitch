import { spawn } from "node:child_process";
export async function terminateProcess(child, graceMs = 3_000) {
    if (!child || child.exitCode !== null || child.signalCode !== null)
        return;
    if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
            stdio: "ignore",
            windowsHide: true,
        });
        await waitForExitOrTimeout(killer, graceMs);
        return;
    }
    try {
        process.kill(-child.pid, "SIGTERM");
    }
    catch (error) {
        if (error?.code !== "ESRCH")
            throw error;
        return;
    }
    await waitForExitOrTimeout(child, graceMs);
    if (child.exitCode === null && child.signalCode === null) {
        try {
            process.kill(-child.pid, "SIGKILL");
        }
        catch (error) {
            if (error?.code !== "ESRCH")
                throw error;
        }
    }
}
export function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function waitForExitOrTimeout(child, milliseconds) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            child.removeListener("exit", finish);
            resolve();
        };
        const timer = setTimeout(finish, milliseconds);
        child.once("exit", finish);
    });
}
//# sourceMappingURL=process.js.map
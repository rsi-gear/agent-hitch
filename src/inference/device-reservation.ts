import { mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { HitchError, atomicWriteJSON, hitchRootId, readJSON, sha256JSON, withFileLock } from "../foundation/index.js";

interface Reservation { root_id: string; service_id: string; gpu_uuid: string }
export const defaultDeviceReservationDirectory = () => path.join(homedir(), ".cache", "agent-hitch", "inference-devices");

/** Survives daemon death. Only confirmed container cleanup releases a reservation;
 * a dead PID alone is never evidence that a GPU is free. Shared across Hitch roots. */
export async function reserveInferenceDevice(directory: string, root: string, serviceId: string, gpuUuid: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const key = sha256JSON(gpuUuid).slice(7);
  await withFileLock(directory, key, async () => {
    const file = path.join(directory, `${key}.json`);
    const existing = await readJSON<Reservation | null>(file, null);
    if (existing) throw new HitchError(`GPU ${gpuUuid} is reserved by another inference service; stop or recover its owning Hitch daemon first`, {
      code: "inference_device_in_use", exitCode: 12,
    });
    await atomicWriteJSON(file, { root_id: hitchRootId(root), service_id: serviceId, gpu_uuid: gpuUuid });
  });
}

export async function releaseInferenceDevice(directory: string, root: string, serviceId: string): Promise<void> {
  let files: string[];
  try { files = await readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of files.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
    await withFileLock(directory, name.slice(0, -5), async () => {
      const file = path.join(directory, name);
      const record = await readJSON<Reservation | null>(file, null);
      if (record?.root_id === hitchRootId(root) && record.service_id === serviceId) await rm(file);
    });
  }
}

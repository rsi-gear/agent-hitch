import { inspectEnvironmentBuild } from "../images/index.js";

export async function inspectBuild(root: string, buildId: string): Promise<Record<string, unknown> | null> {
  const inspected = await inspectEnvironmentBuild(root, buildId);
  return inspected ? { record: inspected.record, manifest: inspected.manifest } : null;
}

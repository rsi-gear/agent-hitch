import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

interface Bytes { files: number; logicalBytes: number; allocatedBlockBytes: number }
/** Disjoint scope accounting. Directory blocks included; symlinks are never followed.
 * Allocated blocks are not exclusive physical bytes on a CoW host. */
export async function countResourceScopes(roots: Array<{ directory: string; classify(relative: string): string }>) {
  const scopes: Record<string, Bytes> = {}, seen = new Set<string>();
  for (const root of roots) {
    const visit = async (file: string): Promise<void> => {
      const stat = await lstat(file).catch(e => { if (e.code !== "ENOENT") throw e; return undefined; }); if (!stat) return;
      if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw new Error(`unsafe accounting path ${file}`);
      const key = `${stat.dev}:${stat.ino}`; if (seen.has(key)) return; seen.add(key);
      const scope = scopes[root.classify(path.relative(root.directory, file))] ??= { files: 0, logicalBytes: 0, allocatedBlockBytes: 0 };
      scope.allocatedBlockBytes += stat.blocks * 512;
      if (stat.isFile()) { scope.files++; scope.logicalBytes += stat.size; return; }
      const names = await readdir(file).catch(e => { if (e.code !== "ENOENT") throw e; return []; });
      for (const name of names) await visit(path.join(file, name));
    };
    await visit(root.directory);
  }
  return scopes;
}
export class ResourceSpaceSampler {
  readonly samples: Array<{ elapsedMs: number; durationMs: number; phase: string; scopes: Record<string, Bytes | { files: null; logicalBytes: null; allocatedBlockBytes: number }>; allocatedBlockBytes: number }> = [];
  private phase = "baseline";
  private stopped = false;
  private pending?: Promise<void>;
  private readonly started = Date.now();
  constructor(readonly roots: Parameters<typeof countResourceScopes>[0], readonly dockerAllocated: () => Promise<number>, readonly intervalMs = 250) {}
  async sample(phase = this.phase) {
    const start = Date.now();
    const scopes: Record<string, Bytes | { files: null; logicalBytes: null; allocatedBlockBytes: number }> = await countResourceScopes(this.roots);
    const docker = await this.dockerAllocated();
    scopes["docker-umbrella-including-images-buildkit-registry-and-container-writes"] = { files: null, logicalBytes: null, allocatedBlockBytes: docker };
    this.samples.push({ elapsedMs: start - this.started, durationMs: Date.now() - start, phase, scopes,
      allocatedBlockBytes: Object.values(scopes).reduce((sum, scope) => sum + scope.allocatedBlockBytes, 0) });
  }
  async mark(phase: string) { this.phase = phase; await this.sample(); }
  start() {
    this.pending = (async () => { while (!this.stopped) { await this.sample(); if (!this.stopped) await new Promise(r => setTimeout(r, this.intervalMs)); } })();
    // Preserve the failure for stop(), while avoiding an unhandled rejection mid-execution.
    void this.pending.catch(() => undefined);
  }
  async stop() { this.stopped = true; await this.pending; }
  report() {
    this.samples.sort((a,b) => a.elapsedMs-b.elapsedMs);
    const peak = this.samples.reduce((a,b) => a.allocatedBlockBytes >= b.allocatedBlockBytes ? a : b);
    const baseline = this.samples[0]!;
    const scopePeaks: Record<string, number> = {};
    for (const sample of this.samples) for (const [name,value] of Object.entries(sample.scopes)) scopePeaks[name] = Math.max(scopePeaks[name] ?? 0,value.allocatedBlockBytes);
    return { protocol: "hitch-joint-space-canary@1", accounting: "allocated blocks, not exclusive physical bytes; hardlinks counted once; disjoint scopes; Docker umbrella counted once; Docker df detail must not be added",
      peakLimit: "sampled lower bound; short transients may be missed; scopes are sequential, not an atomic filesystem snapshot", requestedIntervalMs: this.intervalMs,
      maxSampleGapMs: Math.max(0,...this.samples.slice(1).map((s,i)=>s.elapsedMs-this.samples[i]!.elapsedMs)),
      sampleCount: this.samples.length, baseline, peak, sampledPeakIncrementBytes: peak.allocatedBlockBytes-baseline.allocatedBlockBytes,
      scopePeaksNotAdditive: scopePeaks, samples: this.samples };
  }
}

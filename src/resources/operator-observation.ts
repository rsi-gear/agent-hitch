import type { ObservedContainerResourcesV1 } from '../domain/index.js';

/** Operator-only recovery of image observations from retained Docker events.
 * This does not invent scheduler leases, CPU use, or enforcement evidence. */
export function operatorDockerObservation(proof: any, expected: {
  runId: string; evalId: string; trialId: string; planDigest: string;
}): ObservedContainerResourcesV1[] {
  if (proof?.protocol !== 'hitch-operator-docker-event-recovery@1'
    || proof.runId !== expected.runId || proof.evalId !== expected.evalId
    || proof.trialId !== expected.trialId || !Array.isArray(proof.events)
    || !/^[a-f0-9]{64}$/.test(proof.rawEventsSha256)) throw new Error('operator observation identity mismatch');
  const starts = proof.events.filter((e: any) => e.action === 'start');
  if (starts.length !== 2 || new Set(starts.map((e: any) => e.role)).size !== 2) throw new Error('one candidate and one verifier observation required');
  return starts.map((e: any) => {
    if (!['candidate', 'verifier'].includes(e.role) || e.consumer?.role !== e.role
      || e.planDigest !== expected.planDigest || !e.name.startsWith(expected.trialId.toLowerCase() + '__')
      || !/^[a-f0-9]{64}$/.test(e.containerId) || !/^sha256:[a-f0-9]{64}$/.test(e.imageConfigDigest)
      || !Number.isSafeInteger(e.time)) throw new Error('operator container binding mismatch');
    const same = (p: any) => p.containerId === e.containerId && p.imageConfigDigest === e.imageConfigDigest
      && p.planDigest === e.planDigest && p.name === e.name && p.role === e.role;
    const created = proof.events.find((p: any) => same(p) && p.action === 'create' && p.time <= e.time);
    const ended = proof.events.find((p: any) => same(p) && p.action === 'die' && p.time >= e.time);
    const destroyed = proof.events.find((p: any) => same(p) && p.action === 'destroy' && p.time >= e.time);
    if (!created || !ended || !destroyed) throw new Error('complete container lifecycle required');
    return { container_id: e.containerId, name: e.name, role: e.role, service: e.service,
      image_config_digest: e.imageConfigDigest,
      first_observed_at: new Date(created.time * 1000).toISOString(),
      last_observed_at: new Date(destroyed.time * 1000).toISOString() };
  });
}

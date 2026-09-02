import type { RemoteCredentialEnvelopeV1, RemoteWorkOfferV1 } from "../domain/index.js";
import { HitchError, PROVIDER_ENVIRONMENT_NAMES } from "../foundation/index.js";

export const DEFAULT_CREDENTIAL_ENVELOPE_TTL_MS = 60_000;

export class RemoteCredentialEnvelopeIssuer {
  private readonly env: NodeJS.ProcessEnv;
  private readonly ttlMs: number;

  constructor(input: { env?: NodeJS.ProcessEnv; ttlMs?: number } = {}) {
    const ttl = input.ttlMs ?? DEFAULT_CREDENTIAL_ENVELOPE_TTL_MS;
    if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 5 * 60_000) {
      throw new TypeError("remote credential envelope TTL is invalid");
    }
    this.env = input.env ?? process.env;
    this.ttlMs = ttl;
  }

  namesFor(explicitNames: readonly string[]): string[] {
    const names = new Set<string>(PROVIDER_ENVIRONMENT_NAMES.filter((name) => this.env[name] !== undefined));
    for (const name of canonicalRemoteCredentialNames(explicitNames)) names.add(name);
    return this.requireAvailable([...names]);
  }

  requireAvailable(value: readonly string[]): string[] {
    const names = canonicalRemoteCredentialNames(value);
    for (const name of names) {
      if (this.env[name] === undefined) {
        throw new HitchError(`remote credential is unavailable: ${name}`, { code: "credential_unavailable", exitCode: 10 });
      }
    }
    return names;
  }

  issue(offer: RemoteWorkOfferV1): RemoteCredentialEnvelopeV1 {
    if (offer.state !== "accepted") throw credentialError("remote credential envelope requires an accepted active lease");
    const credentials: Record<string, string> = {};
    for (const name of offer.credential_names ?? []) {
      const value = this.env[name];
      if (value === undefined) {
        throw new HitchError(`remote credential is unavailable: ${name}`, { code: "credential_unavailable", exitCode: 10 });
      }
      credentials[name] = value;
    }
    const issued = new Date();
    return {
      schema_version: "1", worker_id: offer.worker_id, generation: offer.generation, offer_id: offer.offer_id,
      lease_id: offer.lease.lease_id, epoch: offer.lease.epoch, issued_at: issued.toISOString(),
      expires_at: new Date(issued.getTime() + this.ttlMs).toISOString(), credentials,
    };
  }
}

export function canonicalRemoteCredentialNames(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length > 256
    || value.some((name) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    || new Set(value).size !== value.length) throw credentialError("remote credential names are invalid");
  return [...value].sort();
}

function credentialError(message: string): HitchError {
  return new HitchError(message, { code: "worker_protocol_invalid", exitCode: 12 });
}

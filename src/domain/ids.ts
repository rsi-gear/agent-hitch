/**
 * Hitch domain layer: branded identifiers and public wire types.
 *
 * Pure types only — this module must not import CLI, daemon, backend, or
 * filesystem orchestration modules (spec §8.4).
 */

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type Sha256 = `sha256:${string}`;
export type RunId = Brand<string, "RunId">;
export type EvalId = Brand<string, "EvalId">;
export type HarnessId = Brand<string, "HarnessId">;
export type ArtifactId = Brand<Sha256, "ArtifactId">;
export type RevisionIdentity = Brand<Sha256, "RevisionIdentity">;
export type PreparationKey = Brand<Sha256, "PreparationKey">;
export type SessionId = Brand<string, "SessionId">;
export type MessageId = Brand<string, "MessageId">;
export type ControllerRuntimeId = Brand<Sha256, "ControllerRuntimeId">;

export function brand<T, B extends string>(value: T): Brand<T, B> {
  return value as Brand<T, B>;
}

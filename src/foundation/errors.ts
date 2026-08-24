import type { RunId } from "../domain/index.js";

export interface HitchErrorOptions {
  code?: string;
  exitCode?: number;
  cause?: unknown;
}

export class HitchError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(message: string, { code = "internal_error", exitCode = 12, cause }: HitchErrorOptions = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HitchError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function invalidInput(message: string, { cause }: { cause?: unknown } = {}): HitchError {
  return new HitchError(message, { code: "invalid_input", exitCode: 2, cause });
}

export type { RunId };

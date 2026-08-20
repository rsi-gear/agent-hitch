export class HitchError extends Error {
    code;
    exitCode;
    constructor(message, { code = "internal_error", exitCode = 12, cause } = {}) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "HitchError";
        this.code = code;
        this.exitCode = exitCode;
    }
}
export function invalidInput(message, { cause } = {}) {
    return new HitchError(message, { code: "invalid_input", exitCode: 2, cause });
}
//# sourceMappingURL=errors.js.map
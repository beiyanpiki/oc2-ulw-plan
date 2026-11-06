export class UlwError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.name = "UlwError";
        this.code = code;
        if (details !== undefined)
            this.details = details;
    }
}
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export function asUlwError(error) {
    if (error instanceof UlwError)
        return error;
    return new UlwError("INTERNAL_ERROR", errorMessage(error));
}
//# sourceMappingURL=errors.js.map
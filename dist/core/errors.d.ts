import type { Json } from "./types.js";
export declare class UlwError extends Error {
    readonly code: string;
    readonly details?: Json;
    constructor(code: string, message: string, details?: Json);
}
export declare function errorMessage(error: unknown): string;
export declare function asUlwError(error: unknown): UlwError;

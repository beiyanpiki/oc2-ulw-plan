import type { Json } from "./types.js";

export class UlwError extends Error {
  readonly code: string;
  readonly details?: Json;

  constructor(code: string, message: string, details?: Json) {
    super(message);
    this.name = "UlwError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function asUlwError(error: unknown): UlwError {
  if (error instanceof UlwError) return error;
  return new UlwError("INTERNAL_ERROR", errorMessage(error));
}

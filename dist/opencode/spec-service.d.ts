import type { Diagnostic, ParsedSpec, SpecRecord } from "../core/types.js";
import { Runtime } from "./runtime.js";
export interface SpecWriteInput {
    id: string;
    content: string;
    strict?: boolean;
    expectedHash?: string;
}
export interface SpecPatchEdit {
    old: string;
    new: string;
    replaceAll?: boolean;
}
export interface SpecPatchInput {
    id: string;
    edits: SpecPatchEdit[];
    strict?: boolean;
    expectedHash?: string;
}
export interface SpecValidation {
    valid: boolean;
    diagnostics: Diagnostic[];
    hash: string;
    path: string;
}
export declare class SpecService {
    private readonly runtime;
    constructor(runtime: Runtime);
    private paths;
    begin(input: {
        id: string;
        request?: string;
        intent?: string;
        strict?: boolean;
    }, sessionID: string): Promise<{
        id: string;
        draftPath: string;
        specPath: string;
        status: string;
        template: string;
    }>;
    /**
     * Persist the spec even when it is not valid yet. This is deliberate: a
     * planner can then repair a 20 KB document with a small `action=patch`
     * instead of regenerating the whole file after the first validation error.
     * Invalid content never leaves `draft` status and can never be published or
     * executed.
     */
    write(input: SpecWriteInput, sessionID: string): Promise<SpecValidation>;
    /**
     * Apply targeted edits to the current spec. Every `old` must match exactly
     * once unless `replaceAll` is set, so an ambiguous patch fails instead of
     * silently changing the wrong task.
     */
    patch(input: SpecPatchInput, sessionID: string): Promise<SpecValidation>;
    validate(id: string, sessionID: string): Promise<SpecValidation>;
    publish(id: string, sessionID: string): Promise<{
        id: string;
        path: string;
        hash: string;
        risk: string;
        status: string;
        reviews: {
            practical?: string;
            adversarial?: string;
        };
    }>;
    reopen(id: string, sessionID: string): Promise<SpecRecord>;
    read(id: string, sessionID: string, kind: "spec" | "draft", offset: number, limit: number): Promise<{
        text: string;
        next: number | null;
        total: number;
        path: string;
    }>;
    list(sessionID: string): Promise<Array<{
        id: string;
        kind: string;
        status: string;
        risk: string;
        hash: string;
        reviews: string;
    }>>;
    status(id: string, sessionID: string): Promise<SpecRecord>;
    validateCurrent(id: string, workspace: string, strict?: boolean): Promise<{
        parsed: ParsedSpec;
        diagnostics: Diagnostic[];
        errors: Diagnostic[];
    }>;
    roughDraft(path: string, sessionID: string): Promise<{
        content: string;
        placeholders: boolean;
    }>;
}

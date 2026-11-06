import type { Diagnostic, ParsedSpec, SpecRecord } from "../core/types.js";
import { Runtime } from "./runtime.js";
export interface SpecWriteInput {
    id: string;
    content: string;
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
        status: string;
    }>;
    write(input: SpecWriteInput, sessionID: string): Promise<SpecValidation>;
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
        status: string;
        risk: string;
        hash: string;
        reviews: string;
    }>>;
    status(id: string, sessionID: string): Promise<SpecRecord>;
    validateCurrent(id: string, workspace: string): Promise<{
        parsed: ParsedSpec;
        diagnostics: Diagnostic[];
        errors: Diagnostic[];
    }>;
    roughDraft(path: string, sessionID: string): Promise<{
        content: string;
        placeholders: boolean;
    }>;
}

import type { Diagnostic } from "../core/types.js";
export interface DiagnosticEntry {
    schema: "ulw-diagnostic/v1";
    at: number;
    workspace: string;
    sessionID?: string;
    agent?: string;
    tool: string;
    action?: string;
    code: string;
    message: string;
}
export declare function diagnosticsPath(workspace: string): string;
export declare function appendDiagnostic(workspace: string, entry: Omit<DiagnosticEntry, "schema" | "at" | "workspace">): Promise<void>;
export declare function readDiagnostics(workspace: string, limit?: number): Promise<DiagnosticEntry[]>;
export declare function formatDiagnostics(entries: DiagnosticEntry[], limit?: number): string[];
export declare function recordSpecDiagnostics(workspace: string, input: {
    sessionID?: string;
    agent?: string;
    action: string;
    diagnostics: Diagnostic[];
}): Promise<void>;

import { Runtime } from "./runtime.js";
/**
 * Host-side snapshot used for monitoring a workspace. It combines the plugin
 * store (specs, runs, role invocations) with the on-disk lock, spec files and
 * diagnostics journal so a stuck or interrupted flow can be diagnosed without
 * reading OpenCode's private database.
 */
export declare class DiagnoseService {
    private readonly runtime;
    constructor(runtime: Runtime);
    private ownerState;
    report(sessionID: string, limit: number): Promise<{
        text: string;
        metadata: Record<string, unknown>;
    }>;
}

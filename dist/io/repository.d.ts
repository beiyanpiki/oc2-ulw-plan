import type { BaselineFile } from "../core/types.js";
export interface GitStatusEntry {
    code: string;
    path: string;
    originalPath?: string;
}
export declare function isGitWorkspace(workspace: string): Promise<boolean>;
export declare function gitOutput(workspace: string, args: string[], maxBuffer?: number): Promise<string>;
export declare function parseStatus(output: string): GitStatusEntry[];
export declare function statusEntries(workspace: string): Promise<GitStatusEntry[]>;
export declare function listProductFiles(workspace: string): Promise<string[]>;
export declare function captureBaseline(workspace: string, runID: string): Promise<{
    commit: string;
    files: Record<string, BaselineFile>;
}>;
export interface FingerprintResult {
    fingerprint: string;
    current: Record<string, BaselineFile>;
    changed: string[];
    added: string[];
    deleted: string[];
    dirtyFiles: string[];
}
export declare function fingerprintWorkspace(workspace: string, baseline: Record<string, BaselineFile>, baselineCommit: string): Promise<FingerprintResult>;
export declare function changedFilesSinceBaseline(workspace: string, baseline: Record<string, BaselineFile>, baselineCommit: string): Promise<string[]>;
export interface DiffArtifact {
    path: string;
    files: string[];
    truncated: boolean;
    bytes: number;
}
export declare function buildDiffArtifact(workspace: string, runID: string, baseline: Record<string, BaselineFile>, baselineCommit: string, changed: string[], limitBytes?: number): Promise<DiffArtifact>;
export declare function gitDiffStat(workspace: string, baselineCommit: string): Promise<string>;

import type { BaselineFile, CheckEvidence, RunRecord, Spec } from "./types.js";
import { WorkspaceStore } from "./store.js";
export interface CreateRunInput {
    spec: Spec;
    specHash: string;
    sourceHashes: Record<string, string>;
    workspace: string;
    projectID: string;
    ownerSessionID: string;
    ownerAgent: string;
    baselineCommit: string;
    baselineFiles: Record<string, BaselineFile>;
    lockToken: string;
    evidenceDir: string;
}
export declare function newRunID(): string;
export declare function createRun(input: CreateRunInput): RunRecord;
export declare function saveRun(store: WorkspaceStore, run: RunRecord): Promise<void>;
export declare function loadRun(store: WorkspaceStore, id: string): Promise<RunRecord>;
export declare function requireOwner(run: RunRecord, sessionID: string): void;
export declare function activeRun(run: RunRecord): boolean;
export declare function claimTask(store: WorkspaceStore, run: RunRecord, spec: Spec, taskID: string, sessionID: string): Promise<RunRecord>;
export declare function checkpointTask(store: WorkspaceStore, run: RunRecord, spec: Spec, taskID: string, fingerprint: string, changedFiles: string[], evidence: CheckEvidence[]): Promise<RunRecord>;
export declare function recordTaskFailure(store: WorkspaceStore, run: RunRecord, taskID: string, signature: string, maxAttempts?: number): Promise<{
    blocked: boolean;
    attempts: number;
    repeated: number;
}>;
export declare function blockTask(store: WorkspaceStore, run: RunRecord, taskID: string, reason: string): Promise<RunRecord>;
export declare function setRunStatus(store: WorkspaceStore, run: RunRecord, status: RunRecord["status"], reason?: string): Promise<RunRecord>;
export declare function checkedTaskIDs(run: RunRecord): string[];
export declare function allTasksChecked(run: RunRecord): boolean;
export declare function taskScope(spec: Spec): Set<string>;
export interface FinalizeInput {
    run: RunRecord;
    spec: Spec;
    currentSpecHash: string;
    currentFingerprint: string;
    changedFiles: string[];
    verifierInvocation: {
        targetHash: string | undefined;
        status: string;
        reportId: string | undefined;
    };
    codeInvocation: {
        targetHash: string | undefined;
        status: string;
        reportId: string | undefined;
    };
    verifierReport: {
        targetHash?: string;
        role: "verifier";
        payload: unknown;
    };
    codeReport: {
        targetHash?: string;
        role: "code-reviewer";
        payload: unknown;
    };
    reportPath: string;
}
export declare function completeRun(store: WorkspaceStore, input: FinalizeInput): Promise<RunRecord>;

import type { CheckEvidence, CommandCheck } from "./types.js";
export interface ProcessResult {
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    cancelled: boolean;
    stdout: string;
    stderr: string;
    truncated: boolean;
    durationMs: number;
}
export interface ProcessInput {
    argv: string[];
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    maxOutputBytes?: number;
}
export declare function runProcess(input: ProcessInput): Promise<ProcessResult>;
export declare function evaluateExpectation(check: CommandCheck, result: ProcessResult): {
    passed: boolean;
    reason: string;
};
export interface PersistEvidenceInput {
    workspace: string;
    runId: string;
    taskId: string;
    check: CommandCheck;
    attempt: number;
    codeFingerprint: string;
    result: ProcessResult;
    passed: boolean;
    reason: string;
}
export declare function persistCommandEvidence(input: PersistEvidenceInput): Promise<CheckEvidence>;
export declare function readEvidence(path: string): Promise<string>;
export declare function openLog(path: string): number;
export declare function closeLog(fd: number): void;

import type { CheckEvidence, RunRecord } from "../core/types.js";
import { Runtime } from "./runtime.js";
export interface StartRunInput {
    specId: string;
    sessionID: string;
    agent: string;
    projectID: string;
    workspace?: string;
    sessionWorkspace?: string;
}
export declare class RunService {
    private readonly runtime;
    constructor(runtime: Runtime);
    private resolveWorkspace;
    workspaceForSession(sessionID: string): Promise<string>;
    workspaceForSessionRun(sessionID: string, runID: string): Promise<string>;
    start(input: StartRunInput): Promise<RunRecord>;
    private markReviewInvocations;
    resume(runID: string, sessionID: string, workspaceOverride?: string, takeover?: boolean): Promise<RunRecord>;
    status(runID: string, sessionID: string): Promise<{
        run: RunRecord;
        text: string;
    }>;
    findSessionRun(workspace: string, sessionID: string): Promise<RunRecord | undefined>;
    findActiveRun(workspace: string, sessionID: string): Promise<RunRecord | undefined>;
    claim(runID: string, taskID: string, sessionID: string): Promise<RunRecord>;
    checkpoint(runID: string, taskID: string, sessionID: string): Promise<{
        run: RunRecord;
        evidence: CheckEvidence[];
    }>;
    block(runID: string, taskID: string, reason: string, sessionID: string): Promise<RunRecord>;
    pause(runID: string, sessionID: string, reason?: string): Promise<RunRecord>;
    freeze(runID: string, sessionID: string): Promise<{
        run: RunRecord;
        diff: string;
        changed: string[];
    }>;
    reopen(runID: string, taskID: string, sessionID: string, reason?: string): Promise<RunRecord>;
    finalize(runID: string, sessionID: string): Promise<{
        run: RunRecord;
        report: string;
    }>;
    private generateReport;
    runDir(workspace: string): Promise<string[]>;
    check(input: {
        runId?: string;
        taskId?: string;
        checkId: string;
    }, sessionID: string, signal: AbortSignal, assertPermission: (checkID: string) => Promise<void>): Promise<{
        evidence: CheckEvidence;
        content: string;
    }>;
}

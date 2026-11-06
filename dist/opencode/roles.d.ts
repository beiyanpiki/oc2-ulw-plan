import type { Json, ReportRecord, RoleInvocation, RoleName, RunRecord, SpecRecord } from "../core/types.js";
import { Runtime } from "./runtime.js";
export interface RoleBinding {
    schema: "ulw-role-binding/v1";
    invocationID: string;
    workspace: string;
    role: RoleName;
    parentSessionID: string;
    specId?: string;
    runId?: string;
    taskId?: string;
    targetHash?: string;
}
export interface RoleStartInput {
    role: RoleName;
    specId?: string;
    runId?: string;
    taskId?: string;
    assignment?: string;
    background: boolean;
}
export interface RoleStartContext {
    sessionID: string;
    agent: string;
    signal?: AbortSignal;
}
export interface RoleResult {
    invocationID: string;
    childSessionID: string;
    status: RoleInvocation["status"];
    reportId?: string;
    verdict?: string;
    summary: string;
}
export declare class RoleService {
    private readonly runtime;
    private readonly runs;
    constructor(runtime: Runtime);
    private ctx;
    start(input: RoleStartInput, parent: RoleStartContext): Promise<RoleResult>;
    private prepareTarget;
    private loadSpec;
    private loadRunTarget;
    private buildPrompt;
    private finish;
    wait(invocationID: string, parentSessionID: string, workspace: string, signal?: AbortSignal): Promise<RoleResult>;
    cancel(invocationID: string, parentSessionID: string, workspace: string): Promise<RoleResult>;
    report(sessionID: string, payload: Json): Promise<ReportRecord>;
    list(sessionID: string, workspace: string): Promise<RoleInvocation[]>;
    currentSpec(specId: string, workspace: string): Promise<SpecRecord>;
    currentRun(runId: string, workspace: string): Promise<RunRecord>;
    used(invocations: Array<{
        id: string;
        value: RoleInvocation;
    }>, role: RoleName, target: {
        specId?: string;
        runId?: string;
        taskId?: string;
    }): number;
    child(sessionID: string): Promise<unknown>;
}

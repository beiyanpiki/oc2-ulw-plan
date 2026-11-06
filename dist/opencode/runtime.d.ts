import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";
import type { RoleName, RunRecord, SpecRecord } from "../core/types.js";
import { WorkspaceStore } from "../core/store.js";
import type { SessionInfo } from "./session.js";
export interface UlwOptions {
    roleTimeoutMs: number;
    checkOutputBytes: number;
    maxFiles: number;
}
export declare const DEFAULT_OPTIONS: UlwOptions;
export declare function readOptions(raw: Record<string, unknown>): UlwOptions;
export declare class Runtime {
    readonly ctx: PluginContext;
    readonly options: UlwOptions;
    readonly assetsDir: string;
    private readonly baseStore;
    private readonly stores;
    private readonly mutexes;
    private readonly activeRoles;
    constructor(ctx: PluginContext);
    store(workspace: string): WorkspaceStore;
    withMutex<T>(key: string, callback: () => Promise<T>): Promise<T>;
    session(sessionID: string): Promise<SessionInfo>;
    sessionWorkspace(session: SessionInfo): string;
    workspaceOfSession(sessionID: string): Promise<{
        session: SessionInfo;
        workspace: string;
    }>;
    roleKey(sessionID: string): string | undefined;
    setRole(sessionID: string, invocationID: string): void;
    clearRole(sessionID: string): void;
    agentExists(agentID: string): Promise<boolean>;
    switchAgent(sessionID: string, agentID: string): Promise<void>;
    loadSpec(specId: string, workspace: string): Promise<{
        content: string;
        path: string;
    } | undefined>;
    specRecord(specId: string, workspace: string): Promise<SpecRecord | undefined>;
    run(runId: string, workspace: string): Promise<RunRecord | undefined>;
    asset(...segments: string[]): string;
    readAsset(...segments: string[]): Promise<string>;
}
export declare function roleProfile(role: RoleName): string;

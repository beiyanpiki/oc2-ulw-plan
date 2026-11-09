import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";
import type { ModelRef } from "../core/types.js";
export interface SessionInfo {
    id: string;
    parentID?: string;
    projectID?: string;
    agent?: string;
    model?: ModelRef;
    title?: string;
    outcome?: "succeeded" | "failed" | "interrupted";
    location?: {
        directory?: string;
    };
    time?: {
        created?: number;
        updated?: number;
        busy?: number;
        idle?: number;
    };
    metadata?: Record<string, unknown>;
}
export declare function getSession(ctx: PluginContext, sessionID: string): Promise<SessionInfo>;
export declare function createChildSession(ctx: PluginContext, input: {
    parentSessionID: string;
    title: string;
    agent: string;
    workspace: string;
    model?: ModelRef;
}): Promise<SessionInfo>;
export declare function promptSession(ctx: PluginContext, sessionID: string, text: string, delivery?: "steer" | "queue"): Promise<void>;
export declare function interruptSession(ctx: PluginContext, sessionID: string): Promise<boolean>;
export declare function removeSession(ctx: PluginContext, sessionID: string): Promise<void>;
export declare function waitForSessionIdle(ctx: PluginContext, sessionID: string, timeoutMs: number, signal?: AbortSignal): Promise<"idle" | "timeout" | "cancelled">;

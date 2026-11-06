import type { PluginContext } from "./context.js";
import { Runtime } from "./runtime.js";
/**
 * Persist failed ulw tool calls next to the workspace artifacts so that a long
 * session can be diagnosed after the fact. Diagnostics are best-effort: a
 * logging failure must never change the outcome of the tool itself.
 */
export declare function registerDiagnostics(ctx: PluginContext, runtime: Runtime): Promise<void>;

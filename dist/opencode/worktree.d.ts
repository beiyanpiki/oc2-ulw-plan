import type { PluginContext } from "./context.js";
import { Runtime } from "./runtime.js";
export declare function prepareWorktree(ctx: PluginContext, runtime: Runtime, canonical: string, specId: string, request: string): Promise<string>;

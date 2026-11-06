import type { PluginContext } from "./context.js";
import { Runtime } from "./runtime.js";
export declare function registerSkills(ctx: PluginContext, runtime: Runtime): Promise<void>;
export declare function registerSessionContext(ctx: PluginContext, runtime: Runtime): Promise<void>;

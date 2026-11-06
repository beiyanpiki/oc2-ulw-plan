import { Plugin } from "@opencode/plugin";
import type { PluginContext } from "./opencode/context.js";
import { Runtime } from "./opencode/runtime.js";
import { registerCommands } from "./opencode/commands.js";
import { registerGuards } from "./opencode/guards.js";
import { registerSessionContext, registerSkills } from "./opencode/skills.js";
import { registerTools } from "./opencode/tools.js";

export const name = "oc2-ulw-plan";

export default Plugin.define({
  id: "oc2-ulw-plan",
  async setup(context: PluginContext) {
    const runtime = new Runtime(context);
    await registerTools(context, runtime);
    await registerCommands(context, runtime);
    await registerGuards(context, runtime);
    await registerSessionContext(context, runtime);
    await registerSkills(context, runtime);
    return () => {
      // Registrations are scoped to the plugin and disposed by OpenCode. Background
      // role waits are bounded by their own timeout and the parent signal.
    };
  },
});

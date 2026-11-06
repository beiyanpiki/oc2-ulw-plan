import { appendDiagnostic } from "../io/diagnostics.js";
/**
 * Persist failed ulw tool calls next to the workspace artifacts so that a long
 * session can be diagnosed after the fact. Diagnostics are best-effort: a
 * logging failure must never change the outcome of the tool itself.
 */
export async function registerDiagnostics(ctx, runtime) {
    await ctx.tool.hook("execute.after", async (event) => {
        if (!event.tool.startsWith("ulw_"))
            return;
        if (event.status !== "error")
            return;
        try {
            const { workspace } = await runtime.workspaceOfSession(event.sessionID);
            const input = event.input;
            await appendDiagnostic(workspace, {
                sessionID: event.sessionID,
                agent: String(event.agent),
                tool: event.tool,
                ...(typeof input?.action === "string" ? { action: input.action } : {}),
                code: "TOOL_ERROR",
                message: event.error.message.slice(0, 4000),
            });
        }
        catch {
            // Diagnostics are advisory.
        }
    });
}
//# sourceMappingURL=diagnostics.js.map
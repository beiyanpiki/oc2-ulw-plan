import { UlwError } from "../core/errors.js";
export async function getSession(ctx, sessionID) {
    const session = (await ctx.session.get({ sessionID }));
    if (session?.id === undefined)
        throw new UlwError("SESSION_NOT_FOUND", `no session: ${sessionID}`);
    return session;
}
export async function createChildSession(ctx, input) {
    const created = (await ctx.session.create({
        parentID: input.parentSessionID,
        title: input.title,
        agent: input.agent,
        ...(input.model === undefined ? {} : { model: input.model }),
        location: { directory: input.workspace },
    }));
    if (created?.id === undefined)
        throw new UlwError("SESSION_CREATE", "child session creation returned no id");
    return created;
}
export async function promptSession(ctx, sessionID, text, delivery = "steer") {
    await ctx.session.prompt({ sessionID, text, delivery });
}
export async function interruptSession(ctx, sessionID) {
    try {
        const result = await ctx.session.interrupt({ sessionID, resume: false });
        return result.interrupted;
    }
    catch {
        return false;
    }
}
export async function removeSession(ctx, sessionID) {
    try {
        await ctx.session.remove({ sessionID });
    }
    catch {
        // A session can already be gone after an interrupted request.
    }
}
export async function waitForSessionIdle(ctx, sessionID, timeoutMs, signal) {
    const deadline = Date.now() + timeoutMs;
    let sawBusy = false;
    while (Date.now() < deadline) {
        if (signal?.aborted === true)
            return "cancelled";
        const session = await getSession(ctx, sessionID);
        if (session.outcome === "succeeded" || session.outcome === "failed" || session.outcome === "interrupted")
            return "idle";
        const busy = session.time?.busy;
        const idle = session.time?.idle;
        if (busy !== undefined)
            sawBusy = true;
        if (sawBusy && idle !== undefined && (busy === undefined || idle >= busy))
            return "idle";
        await new Promise((resolveDelay) => {
            setTimeout(resolveDelay, 500);
        });
    }
    return "timeout";
}
//# sourceMappingURL=session.js.map
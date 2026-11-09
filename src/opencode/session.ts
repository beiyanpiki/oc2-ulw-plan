import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";
import { UlwError } from "../core/errors.js";
import type { ModelRef } from "../core/types.js";

export interface SessionInfo {
  id: string;
  parentID?: string;
  projectID?: string;
  agent?: string;
  model?: ModelRef;
  title?: string;
  outcome?: "succeeded" | "failed" | "interrupted";
  location?: { directory?: string };
  time?: { created?: number; updated?: number; busy?: number; idle?: number };
  metadata?: Record<string, unknown>;
}

export async function getSession(ctx: PluginContext, sessionID: string): Promise<SessionInfo> {
  const session = (await ctx.session.get({ sessionID })) as unknown as SessionInfo;
  if (session?.id === undefined) throw new UlwError("SESSION_NOT_FOUND", `no session: ${sessionID}`);
  return session;
}

export async function createChildSession(
  ctx: PluginContext,
  input: { parentSessionID: string; title: string; agent: string; workspace: string; model?: ModelRef },
): Promise<SessionInfo> {
  const created = (await ctx.session.create({
    parentID: input.parentSessionID as never,
    title: input.title,
    agent: input.agent as never,
    ...(input.model === undefined ? {} : { model: input.model as never }),
    location: { directory: input.workspace },
  })) as unknown as SessionInfo;
  if (created?.id === undefined) throw new UlwError("SESSION_CREATE", "child session creation returned no id");
  return created;
}

export async function promptSession(
  ctx: PluginContext,
  sessionID: string,
  text: string,
  delivery: "steer" | "queue" = "steer",
): Promise<void> {
  await ctx.session.prompt({ sessionID, text, delivery });
}

export async function interruptSession(ctx: PluginContext, sessionID: string): Promise<boolean> {
  try {
    const result = await ctx.session.interrupt({ sessionID, resume: false });
    return result.interrupted;
  } catch {
    return false;
  }
}

export async function removeSession(ctx: PluginContext, sessionID: string): Promise<void> {
  try {
    await ctx.session.remove({ sessionID });
  } catch {
    // A session can already be gone after an interrupted request.
  }
}

export async function waitForSessionIdle(
  ctx: PluginContext,
  sessionID: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<"idle" | "timeout" | "cancelled"> {
  const deadline = Date.now() + timeoutMs;
  let sawBusy = false;
  while (Date.now() < deadline) {
    if (signal?.aborted === true) return "cancelled";
    const session = await getSession(ctx, sessionID);
    if (session.outcome === "succeeded" || session.outcome === "failed" || session.outcome === "interrupted") return "idle";
    const busy = session.time?.busy;
    const idle = session.time?.idle;
    if (busy !== undefined) sawBusy = true;
    if (sawBusy && idle !== undefined && (busy === undefined || idle >= busy)) return "idle";
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, 500);
    });
  }
  return "timeout";
}

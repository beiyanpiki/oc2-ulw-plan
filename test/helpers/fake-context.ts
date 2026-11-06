import { randomUUID } from "node:crypto";
import { MemoryStore } from "../../src/core/store.js";
import type { PluginContext } from "../../src/opencode/context.js";
import type { SessionInfo } from "../../src/opencode/session.js";

export interface FakeContextOptions {
  workspace: string;
  projectID?: string;
}

export interface FakeContext {
  ctx: PluginContext;
  sessions: Map<string, SessionInfo>;
  tools: Array<Record<string, unknown>>;
  commands: Array<Record<string, unknown>>;
  skills: Array<Record<string, unknown>>;
  toolHooks: Array<(event: Record<string, unknown>) => Promise<void> | void>;
  sessionHooks: Array<(event: Record<string, unknown>) => Promise<void> | void>;
  permissions: Array<Record<string, unknown>>;
  storage: MemoryStore;
}

export function createFakeContext(options: FakeContextOptions): FakeContext {
  const storage = new MemoryStore();
  const sessions = new Map<string, SessionInfo>();
  const tools: Array<Record<string, unknown>> = [];
  const commands: Array<Record<string, unknown>> = [];
  const skills: Array<Record<string, unknown>> = [];
  const toolHooks: Array<(event: Record<string, unknown>) => Promise<void> | void> = [];
  const sessionHooks: Array<(event: Record<string, unknown>) => Promise<void> | void> = [];
  const permissions: Array<Record<string, unknown>> = [];

  const sessionApi = {
    get: async ({ sessionID }: { sessionID: string }) => {
      const session = sessions.get(sessionID);
      if (session === undefined) throw new Error(`no session ${sessionID}`);
      return session;
    },
    create: async (input: { parentID?: string; title?: string; agent?: string; location?: { directory?: string }; permissions?: unknown }) => {
      const session: SessionInfo = {
        id: `ses_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
        ...(input.parentID === undefined ? {} : { parentID: input.parentID }),
        projectID: options.projectID ?? "project",
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.title === undefined ? {} : { title: input.title }),
        location: { directory: input.location?.directory ?? options.workspace },
        time: { created: Date.now(), updated: Date.now() },
      };
      sessions.set(session.id, session);
      return session;
    },
    switchAgent: async ({ sessionID, agent }: { sessionID: string; agent: string }) => {
      const session = sessions.get(sessionID);
      if (session === undefined) throw new Error(`no session ${sessionID}`);
      session.agent = agent;
    },
    prompt: async () => ({ id: "msg", sessionID: "ses", time: { created: Date.now() }, type: "user", payload: { text: "" }, delivery: "steer" }),
    interrupt: async () => ({ interrupted: false }),
    remove: async () => undefined,
    wait: async () => undefined,
    update: async () => undefined,
    context: async () => [],
  };

  const toolEditor = {
    list: () => tools,
    get: (id: string) => tools.find((tool) => tool.id === id),
    namespace: () => undefined,
    add: (tool: Record<string, unknown>) => tools.push(tool),
    update: () => undefined,
    remove: () => undefined,
  };

  const commandEditor = {
    add: (command: Record<string, unknown>) => commands.push(command),
  };

  const skillEditor = {
    list: () => skills,
    get: (id: string) => skills.find((skill) => skill.id === id),
    add: (skill: Record<string, unknown>) => skills.push(skill),
    update: () => undefined,
    remove: () => undefined,
  };

  const ctx = {
    app: { version: "2.2.5" },
    location: { directory: options.workspace, project: { id: options.projectID ?? "project", directory: options.workspace, canonical: options.workspace } },
    options: {},
    storage: {
      get: (key: string) => storage.get(key),
      set: (key: string, value: unknown) => storage.set(key, value),
      remove: (key: string) => storage.remove(key),
      scan: async (input: { prefix: string; limit?: number }) => {
        const entries = await storage.scan(input.prefix, input.limit ?? 1000);
        return { entries };
      },
    },
    session: { ...sessionApi, hook: async (name: string, callback: (event: Record<string, unknown>) => Promise<void> | void) => {
      if (name === "context") sessionHooks.push(callback);
      return { dispose: async () => undefined };
    } },
    tool: {
      list: async () => tools,
      transform: async (callback: (editor: typeof toolEditor) => void) => {
        callback(toolEditor);
        return { dispose: async () => undefined };
      },
      reload: async () => undefined,
      hook: async (name: string, callback: (event: Record<string, unknown>) => Promise<void> | void) => {
        if (name === "execute.before") toolHooks.push(callback);
        return { dispose: async () => undefined };
      },
    },
    command: {
      list: async () => ({ data: commands }),
      transform: async (callback: (editor: typeof commandEditor) => void) => {
        callback(commandEditor);
        return { dispose: async () => undefined };
      },
      reload: async () => undefined,
    },
    skill: {
      list: async () => ({ data: skills }),
      transform: async (callback: (editor: typeof skillEditor) => void) => {
        callback(skillEditor);
        return { dispose: async () => undefined };
      },
      reload: async () => undefined,
    },
    agent: {
      list: async () => ({ data: [] }),
      get: async ({ agentID }: { agentID: string }) => ({ id: agentID }),
      transform: async () => ({ dispose: async () => undefined }),
      reload: async () => undefined,
    },
    permission: {
      assert: async (input: Record<string, unknown>) => {
        permissions.push(input);
      },
      list: async () => ({ data: [] }),
      get: async () => undefined,
      reply: async () => undefined,
      hook: async () => ({ dispose: async () => undefined }),
    },
    event: {
      subscribe: async function* () {
        return;
      },
    },
    worktree: {
      create: async ({ name }: { name: string }) => ({ directory: `${options.workspace}-${name}` }),
      list: async () => ({ data: [] }),
      refresh: async () => undefined,
      remove: async () => undefined,
      transform: async () => ({ dispose: async () => undefined }),
      reload: async () => undefined,
    },
    ...sessionApi,
  };

  // The real context keeps session APIs under `session`; the spread above is for
  // convenience in ad-hoc fakes and must not replace the namespaced surface.
  (ctx as Record<string, unknown>).session = { ...sessionApi, hook: ctx.session.hook };
  return { ctx: ctx as unknown as PluginContext, sessions, tools, commands, skills, toolHooks, sessionHooks, permissions, storage };
}

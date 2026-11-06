import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";
import type { RoleName, RunRecord, SpecRecord } from "../core/types.js";
import { UlwError } from "../core/errors.js";
import { WorkspaceStore, type JsonStore } from "../core/store.js";
import type { SessionInfo } from "./session.js";
import { workspaceKey } from "../io/workspace.js";

export interface UlwOptions {
  roleTimeoutMs: number;
  checkOutputBytes: number;
  maxFiles: number;
}

export const DEFAULT_OPTIONS: UlwOptions = {
  roleTimeoutMs: 15 * 60_000,
  checkOutputBytes: 10 * 1024 * 1024,
  maxFiles: 50_000,
};

export function readOptions(raw: Record<string, unknown>): UlwOptions {
  const number = (value: unknown, fallback: number, min: number, max: number): number => {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
  };
  return {
    roleTimeoutMs: number(raw.roleTimeoutMs, DEFAULT_OPTIONS.roleTimeoutMs, 30_000, 60 * 60_000),
    checkOutputBytes: number(raw.checkOutputBytes, DEFAULT_OPTIONS.checkOutputBytes, 1024, 50 * 1024 * 1024),
    maxFiles: number(raw.maxFiles, DEFAULT_OPTIONS.maxFiles, 1000, 200_000),
  };
}

class ContextStore implements JsonStore {
  constructor(private readonly ctx: PluginContext) {}

  async get(key: string): Promise<unknown | undefined> {
    return this.ctx.storage.get(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.ctx.storage.set(key, value as never);
  }

  async remove(key: string): Promise<void> {
    await this.ctx.storage.remove(key);
  }

  async scan(prefix: string, limit = 10_000): Promise<Array<{ key: string; value: unknown }>> {
    const entries: Array<{ key: string; value: unknown }> = [];
    let after: string | undefined;
    while (entries.length < limit) {
      const options: { prefix: string; after?: string; limit: number } = { prefix, limit: Math.min(500, limit - entries.length) };
      if (after !== undefined) options.after = after;
      const page = await this.ctx.storage.scan(options);
      for (const entry of page.entries) entries.push({ key: entry.key, value: entry.value });
      if (page.next === undefined) break;
      after = page.next;
    }
    return entries;
  }
}

export class Runtime {
  readonly ctx: PluginContext;
  readonly options: UlwOptions;
  readonly assetsDir: string;
  private readonly baseStore: ContextStore;
  private readonly stores = new Map<string, WorkspaceStore>();
  private readonly mutexes = new Map<string, Promise<void>>();
  private readonly activeRoles = new Map<string, string>();

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
    this.options = readOptions(ctx.options as Record<string, unknown>);
    this.assetsDir = join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "assets");
    this.baseStore = new ContextStore(ctx);
  }

  store(workspace: string): WorkspaceStore {
    const key = workspaceKey(workspace);
    let store = this.stores.get(key);
    if (store === undefined) {
      store = new WorkspaceStore(this.baseStore, key);
      this.stores.set(key, store);
    }
    return store;
  }

  async withMutex<T>(key: string, callback: () => Promise<T>): Promise<T> {
    const previous = this.mutexes.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const current = previous.then(() => gate);
    this.mutexes.set(key, current);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (this.mutexes.get(key) === current) this.mutexes.delete(key);
    }
  }

  async session(sessionID: string): Promise<SessionInfo> {
    const session = (await this.ctx.session.get({ sessionID })) as unknown as SessionInfo;
    if (session?.id === undefined) throw new UlwError("SESSION_NOT_FOUND", `no session: ${sessionID}`);
    return session;
  }

  sessionWorkspace(session: SessionInfo): string {
    const directory = session.location?.directory;
    if (typeof directory === "string" && directory !== "") return resolve(directory);
    return resolve(this.ctx.location.directory);
  }

  async workspaceOfSession(sessionID: string): Promise<{ session: SessionInfo; workspace: string }> {
    const session = await this.session(sessionID);
    return { session, workspace: this.sessionWorkspace(session) };
  }

  roleKey(sessionID: string): string | undefined {
    return this.activeRoles.get(sessionID);
  }

  setRole(sessionID: string, invocationID: string): void {
    this.activeRoles.set(sessionID, invocationID);
  }

  clearRole(sessionID: string): void {
    this.activeRoles.delete(sessionID);
  }

  async agentExists(agentID: string): Promise<boolean> {
    try {
      const agent = await this.ctx.agent.get({ agentID });
      return agent !== undefined;
    } catch {
      return false;
    }
  }

  async switchAgent(sessionID: string, agentID: string): Promise<void> {
    if (!(await this.agentExists(agentID))) {
      throw new UlwError("AGENT_PROFILE_MISSING", `OpenCode agent profile is not installed: ${agentID}; run the plugin init command`);
    }
    await this.ctx.session.switchAgent({ sessionID, agent: agentID });
  }

  async loadSpec(specId: string, workspace: string): Promise<{ content: string; path: string } | undefined> {
    const { readFile } = await import("node:fs/promises");
    const path = join(workspace, ".opencode", "ulw", "specs", `${specId}.md`);
    try {
      return { content: await readFile(path, "utf8"), path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async specRecord(specId: string, workspace: string): Promise<SpecRecord | undefined> {
    return this.store(workspace).getSpec<SpecRecord>(specId);
  }

  async run(runId: string, workspace: string): Promise<RunRecord | undefined> {
    return this.store(workspace).getRun<RunRecord>(runId);
  }

  asset(...segments: string[]): string {
    return join(this.assetsDir, ...segments);
  }

  async readAsset(...segments: string[]): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    return readFile(this.asset(...segments), "utf8");
  }
}

export function roleProfile(role: RoleName): string {
  switch (role) {
    case "verifier":
      return "ulw-verifier";
    case "worker":
      return "ulw-worker";
    case "code-reviewer":
      return "ulw-readonly";
    default:
      return "ulw-readonly";
  }
}

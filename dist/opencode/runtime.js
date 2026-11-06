import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UlwError } from "../core/errors.js";
import { WorkspaceStore } from "../core/store.js";
import { workspaceKey } from "../io/workspace.js";
export const DEFAULT_OPTIONS = {
    roleTimeoutMs: 15 * 60_000,
    checkOutputBytes: 10 * 1024 * 1024,
    maxFiles: 50_000,
};
export function readOptions(raw) {
    const number = (value, fallback, min, max) => {
        const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
        return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
    };
    return {
        roleTimeoutMs: number(raw.roleTimeoutMs, DEFAULT_OPTIONS.roleTimeoutMs, 30_000, 60 * 60_000),
        checkOutputBytes: number(raw.checkOutputBytes, DEFAULT_OPTIONS.checkOutputBytes, 1024, 50 * 1024 * 1024),
        maxFiles: number(raw.maxFiles, DEFAULT_OPTIONS.maxFiles, 1000, 200_000),
    };
}
class ContextStore {
    ctx;
    constructor(ctx) {
        this.ctx = ctx;
    }
    async get(key) {
        return this.ctx.storage.get(key);
    }
    async set(key, value) {
        await this.ctx.storage.set(key, value);
    }
    async remove(key) {
        await this.ctx.storage.remove(key);
    }
    async scan(prefix, limit = 10_000) {
        const entries = [];
        let after;
        while (entries.length < limit) {
            const options = { prefix, limit: Math.min(500, limit - entries.length) };
            if (after !== undefined)
                options.after = after;
            const page = await this.ctx.storage.scan(options);
            for (const entry of page.entries)
                entries.push({ key: entry.key, value: entry.value });
            if (page.next === undefined)
                break;
            after = page.next;
        }
        return entries;
    }
}
export class Runtime {
    ctx;
    options;
    assetsDir;
    baseStore;
    stores = new Map();
    mutexes = new Map();
    activeRoles = new Map();
    constructor(ctx) {
        this.ctx = ctx;
        this.options = readOptions(ctx.options);
        this.assetsDir = join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "assets");
        this.baseStore = new ContextStore(ctx);
    }
    store(workspace) {
        const key = workspaceKey(workspace);
        let store = this.stores.get(key);
        if (store === undefined) {
            store = new WorkspaceStore(this.baseStore, key);
            this.stores.set(key, store);
        }
        return store;
    }
    async withMutex(key, callback) {
        const previous = this.mutexes.get(key) ?? Promise.resolve();
        let release = () => undefined;
        const gate = new Promise((resolveGate) => {
            release = resolveGate;
        });
        const current = previous.then(() => gate);
        this.mutexes.set(key, current);
        await previous;
        try {
            return await callback();
        }
        finally {
            release();
            if (this.mutexes.get(key) === current)
                this.mutexes.delete(key);
        }
    }
    async session(sessionID) {
        const session = (await this.ctx.session.get({ sessionID }));
        if (session?.id === undefined)
            throw new UlwError("SESSION_NOT_FOUND", `no session: ${sessionID}`);
        return session;
    }
    sessionWorkspace(session) {
        const directory = session.location?.directory;
        if (typeof directory === "string" && directory !== "")
            return resolve(directory);
        return resolve(this.ctx.location.directory);
    }
    async workspaceOfSession(sessionID) {
        const session = await this.session(sessionID);
        return { session, workspace: this.sessionWorkspace(session) };
    }
    roleKey(sessionID) {
        return this.activeRoles.get(sessionID);
    }
    setRole(sessionID, invocationID) {
        this.activeRoles.set(sessionID, invocationID);
    }
    clearRole(sessionID) {
        this.activeRoles.delete(sessionID);
    }
    async agentExists(agentID) {
        try {
            const agent = await this.ctx.agent.get({ agentID });
            return agent !== undefined;
        }
        catch {
            return false;
        }
    }
    async switchAgent(sessionID, agentID) {
        if (!(await this.agentExists(agentID))) {
            throw new UlwError("AGENT_PROFILE_MISSING", `OpenCode agent profile is not installed: ${agentID}; run the plugin init command`);
        }
        await this.ctx.session.switchAgent({ sessionID, agent: agentID });
    }
    async loadSpec(specId, workspace) {
        const { readFile } = await import("node:fs/promises");
        const path = join(workspace, ".opencode", "ulw", "specs", `${specId}.md`);
        try {
            return { content: await readFile(path, "utf8"), path };
        }
        catch (error) {
            if (error.code === "ENOENT")
                return undefined;
            throw error;
        }
    }
    async specRecord(specId, workspace) {
        return this.store(workspace).getSpec(specId);
    }
    async run(runId, workspace) {
        return this.store(workspace).getRun(runId);
    }
    asset(...segments) {
        return join(this.assetsDir, ...segments);
    }
    async readAsset(...segments) {
        const { readFile } = await import("node:fs/promises");
        return readFile(this.asset(...segments), "utf8");
    }
}
export function roleProfile(role) {
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
//# sourceMappingURL=runtime.js.map
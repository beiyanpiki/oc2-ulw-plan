import { open, readFile, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { UlwError } from "../core/errors.js";
import { atomicWriteFile, ensureArtifactDir } from "./paths.js";
function lockPath(workspace) {
    return join(workspace, ".opencode", "ulw", ".locks", "workspace.lock");
}
export function serviceIdentity() {
    return createHash("sha256").update(`${process.execPath}:${process.argv[1] ?? ""}`).digest("hex").slice(0, 16);
}
export async function readLock(workspace) {
    try {
        const content = await readFile(lockPath(workspace), "utf8");
        const parsed = JSON.parse(content);
        if (parsed.schema !== "ulw-lock/v1" || typeof parsed.token !== "string")
            return undefined;
        return parsed;
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT")
            return undefined;
        throw error;
    }
}
export async function acquireLock(workspace, owner) {
    const dir = await ensureArtifactDir(workspace, ".locks");
    const path = join(dir, "workspace.lock");
    const info = {
        schema: "ulw-lock/v1",
        token: randomUUID(),
        pid: process.pid,
        serviceId: serviceIdentity(),
        sessionID: owner.sessionID,
        runID: owner.runID,
        acquiredAt: Date.now(),
    };
    let handle;
    try {
        handle = await open(path, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(info, null, 2)}\n`, "utf8");
        await handle.sync();
        return info;
    }
    catch (error) {
        const code = error.code;
        if (code === "EEXIST") {
            const existing = await readLock(workspace);
            throw new UlwError("WORKSPACE_LOCKED", `another run owns this workspace: ${existing?.runID ?? "unknown"}`, {
                ownerSessionID: existing?.sessionID ?? null,
                ownerRunID: existing?.runID ?? null,
                ownerPid: existing?.pid ?? null,
            });
        }
        throw error;
    }
    finally {
        await handle?.close();
    }
}
export async function releaseLock(workspace, token) {
    const existing = await readLock(workspace);
    if (existing === undefined || existing.token !== token)
        return false;
    await unlink(lockPath(workspace)).catch((error) => {
        if (error.code !== "ENOENT")
            throw error;
    });
    return true;
}
export function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
export async function inspectRecoverable(workspace, expectedSessionID, expectedRunID) {
    const lock = await readLock(workspace);
    if (lock === undefined)
        return { recoverable: true, reason: "no active lock" };
    if (lock.sessionID !== expectedSessionID || lock.runID !== expectedRunID) {
        return { recoverable: false, reason: "lock belongs to a different session or run", lock };
    }
    if (lock.pid === process.pid) {
        return { recoverable: true, reason: "lock is owned by this service process", lock };
    }
    if (!pidAlive(lock.pid)) {
        return { recoverable: true, reason: "lock owner process is no longer alive", lock };
    }
    return { recoverable: false, reason: "lock owner process is still alive; explicit manual inspection is required", lock };
}
export async function transferLock(workspace, expected, sessionID, runID) {
    const current = await readLock(workspace);
    if (current === undefined || current.token !== expected.token) {
        throw new UlwError("LOCK_CHANGED", "workspace lock changed during recovery");
    }
    const next = {
        ...current,
        token: randomUUID(),
        pid: process.pid,
        sessionID,
        runID,
        acquiredAt: Date.now(),
    };
    await atomicWriteFile(lockPath(workspace), `${JSON.stringify(next, null, 2)}\n`);
    return next;
}
//# sourceMappingURL=lock.js.map
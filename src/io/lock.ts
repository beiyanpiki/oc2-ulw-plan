import { open, readFile, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { UlwError } from "../core/errors.js";
import { atomicWriteFile, ensureArtifactDir } from "./paths.js";

export interface LockOwner {
  token: string;
  pid: number;
  serviceId: string;
  sessionID: string;
  runID: string;
  acquiredAt: number;
}

export interface LockInfo extends LockOwner {
  schema: "ulw-lock/v1";
}

function lockPath(workspace: string): string {
  return join(workspace, ".opencode", "ulw", ".locks", "workspace.lock");
}

export function serviceIdentity(): string {
  return createHash("sha256").update(`${process.execPath}:${process.argv[1] ?? ""}`).digest("hex").slice(0, 16);
}

export async function readLock(workspace: string): Promise<LockInfo | undefined> {
  try {
    const content = await readFile(lockPath(workspace), "utf8");
    const parsed = JSON.parse(content) as Partial<LockInfo>;
    if (parsed.schema !== "ulw-lock/v1" || typeof parsed.token !== "string") return undefined;
    return parsed as LockInfo;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

export async function acquireLock(workspace: string, owner: { sessionID: string; runID: string }): Promise<LockInfo> {
  const dir = await ensureArtifactDir(workspace, ".locks");
  const path = join(dir, "workspace.lock");
  const info: LockInfo = {
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
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      const existing = await readLock(workspace);
      throw new UlwError("WORKSPACE_LOCKED", `another run owns this workspace: ${existing?.runID ?? "unknown"}`, {
        ownerSessionID: existing?.sessionID ?? null,
        ownerRunID: existing?.runID ?? null,
        ownerPid: existing?.pid ?? null,
      });
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function releaseLock(workspace: string, token: string): Promise<boolean> {
  const existing = await readLock(workspace);
  if (existing === undefined || existing.token !== token) return false;
  await unlink(lockPath(workspace)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  return true;
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface RecoveryDecision {
  recoverable: boolean;
  reason: string;
  lock?: LockInfo;
}

export async function inspectRecoverable(workspace: string, expectedSessionID: string, expectedRunID: string): Promise<RecoveryDecision> {
  const lock = await readLock(workspace);
  if (lock === undefined) return { recoverable: true, reason: "no active lock" };
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

export async function transferLock(workspace: string, expected: LockInfo, sessionID: string, runID: string): Promise<LockInfo> {
  const current = await readLock(workspace);
  if (current === undefined || current.token !== expected.token) {
    throw new UlwError("LOCK_CHANGED", "workspace lock changed during recovery");
  }
  const next: LockInfo = {
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

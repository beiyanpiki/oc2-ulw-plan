import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readlink, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createTwoFilesPatch } from "diff";
import { UlwError } from "../core/errors.js";
import { isWithin } from "../core/spec.js";
import type { BaselineFile } from "../core/types.js";
import { atomicWriteFile, ensureArtifactDir } from "./paths.js";

const exec = promisify(execFile);
const MAX_PRODUCT_FILES = 50_000;
const MAX_HASH_BYTES = 50 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_FILE_BYTES = 2 * 1024 * 1024;
const ARTIFACT_PREFIX = ".opencode/ulw/";

export interface GitStatusEntry {
  code: string;
  path: string;
  originalPath?: string;
}

export async function isGitWorkspace(workspace: string): Promise<boolean> {
  try {
    const { stdout } = await exec("git", ["-C", workspace, "rev-parse", "--is-inside-work-tree"], { maxBuffer: 1024 * 1024 });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function gitOutput(workspace: string, args: string[], maxBuffer = 10 * 1024 * 1024): Promise<string> {
  const { stdout } = await exec("git", ["-C", workspace, ...args], { maxBuffer, encoding: "buffer" });
  return stdout.toString("utf8");
}

export function parseStatus(output: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  const fields = output.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === undefined || field.length < 4) continue;
    const code = field.slice(0, 2);
    const path = field.slice(3);
    if (code[0] === "R" || code[0] === "C") {
      const next = fields[index + 1];
      if (next !== undefined) {
        entries.push({ code, path: next, originalPath: path });
        index += 1;
        continue;
      }
    }
    entries.push({ code, path });
  }
  return entries;
}

export async function statusEntries(workspace: string): Promise<GitStatusEntry[]> {
  if (!(await isGitWorkspace(workspace))) throw new UlwError("NOT_GIT", `not a Git worktree: ${workspace}`);
  const output = await gitOutput(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return parseStatus(output);
}

export async function listProductFiles(workspace: string): Promise<string[]> {
  const output = await gitOutput(workspace, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const files = output.split("\0").filter((path) => path !== "" && !path.startsWith(ARTIFACT_PREFIX) && !path.startsWith(".opencode/ulw/"));
  if (files.length > MAX_PRODUCT_FILES) {
    throw new UlwError("REPO_TOO_LARGE", `workspace has ${files.length} product files; limit is ${MAX_PRODUCT_FILES}`);
  }
  return [...new Set(files)].sort();
}

async function hashPath(path: string): Promise<{ sha256: string; kind: BaselineFile["kind"]; bytes?: Buffer }> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sha256: emptyHash(), kind: "missing" };
    throw error;
  }
  if (info.isSymbolicLink()) {
    const target = await readlink(path);
    return { sha256: createHash("sha256").update(`link:${target}`).digest("hex"), kind: "symlink", bytes: Buffer.from(target) };
  }
  if (!info.isFile()) throw new UlwError("BASELINE_TYPE", `unsupported file type: ${path}`);
  if (info.size > MAX_HASH_BYTES) throw new UlwError("BASELINE_TOO_LARGE", `file exceeds ${MAX_HASH_BYTES} bytes: ${path}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  const bytes = info.size <= MAX_SNAPSHOT_FILE_BYTES ? await readFile(path) : undefined;
  return bytes === undefined ? { sha256: hash.digest("hex"), kind: "file" } : { sha256: hash.digest("hex"), kind: "file", bytes };
}

function emptyHash(): string {
  return createHash("sha256").update("").digest("hex");
}

export async function captureBaseline(workspace: string, runID: string): Promise<{ commit: string; files: Record<string, BaselineFile> }> {
  if (!(await isGitWorkspace(workspace))) throw new UlwError("NOT_GIT", `execution requires a Git worktree: ${workspace}`);
  const status = await statusEntries(workspace);
  const dirty = new Set<string>();
  for (const entry of status) {
    dirty.add(entry.path);
    if (entry.originalPath !== undefined) dirty.add(entry.originalPath);
  }
  const commit = await gitOutput(workspace, ["rev-parse", "HEAD"]).then((value) => value.trim()).catch(() => {
    throw new UlwError("NO_HEAD", "execution requires at least one Git commit");
  });
  const fileList = await listProductFiles(workspace);
  const files: Record<string, BaselineFile> = {};
  let snapshotBytes = 0;
  const snapshotRoot = await ensureArtifactDir(workspace, "evidence", runID, "baseline");
  for (const path of fileList) {
    const absolute = resolve(workspace, path);
    if (!isWithin(workspace, absolute)) throw new UlwError("PATH_TRAVERSAL", `tracked path leaves workspace: ${path}`);
    const hashed = await hashPath(absolute);
    const record: BaselineFile = { path, sha256: hashed.sha256, kind: hashed.kind, dirty: dirty.has(path) };
    if (hashed.bytes !== undefined && (dirty.has(path) || hashed.kind === "symlink")) {
      if (snapshotBytes + hashed.bytes.byteLength <= MAX_SNAPSHOT_BYTES) {
        const snapshot = join(snapshotRoot, path.replaceAll("/", "__"));
        await atomicWriteFile(snapshot, hashed.bytes);
        record.snapshotPath = snapshot;
        snapshotBytes += hashed.bytes.byteLength;
      }
    }
    files[path] = record;
  }
  return { commit, files };
}

export interface FingerprintResult {
  fingerprint: string;
  current: Record<string, BaselineFile>;
  changed: string[];
  added: string[];
  deleted: string[];
  dirtyFiles: string[];
}

export async function fingerprintWorkspace(
  workspace: string,
  baseline: Record<string, BaselineFile>,
  baselineCommit: string,
): Promise<FingerprintResult> {
  const files = await listProductFiles(workspace);
  const current: Record<string, BaselineFile> = {};
  for (const path of files) {
    const absolute = resolve(workspace, path);
    if (!isWithin(workspace, absolute)) throw new UlwError("PATH_TRAVERSAL", `tracked path leaves workspace: ${path}`);
    const hashed = await hashPath(absolute);
    current[path] = { path, sha256: hashed.sha256, kind: hashed.kind, dirty: false };
  }
  const changed: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  for (const [path, file] of Object.entries(current)) {
    const before = baseline[path];
    if (before === undefined) added.push(path);
    else if (before.sha256 !== file.sha256 || before.kind !== file.kind) changed.push(path);
  }
  for (const path of Object.keys(baseline)) {
    if (current[path] === undefined) deleted.push(path);
  }
  const dirtyFiles = [...added, ...changed, ...deleted].sort();
  const fingerprint = createHash("sha256")
    .update(baselineCommit)
    .update("\n")
    .update([...files].sort().map((path) => `${path}:${current[path]?.sha256 ?? ""}`).join("\n"))
    .digest("hex");
  return { fingerprint, current, changed, added, deleted, dirtyFiles };
}

export async function changedFilesSinceBaseline(workspace: string, baseline: Record<string, BaselineFile>, baselineCommit: string): Promise<string[]> {
  return (await fingerprintWorkspace(workspace, baseline, baselineCommit)).dirtyFiles;
}

async function baselineContent(workspace: string, baselineCommit: string, file: BaselineFile): Promise<string | undefined> {
  if (file.snapshotPath !== undefined) {
    try {
      return (await readFile(file.snapshotPath)).toString("utf8");
    } catch {
      return undefined;
    }
  }
  if (file.kind === "missing") return "";
  if (file.kind === "symlink") {
    try {
      return await readlink(resolve(workspace, file.path));
    } catch {
      return undefined;
    }
  }
  try {
    const output = await exec("git", ["-C", workspace, "show", `${baselineCommit}:${file.path}`], { maxBuffer: MAX_SNAPSHOT_FILE_BYTES, encoding: "buffer" });
    return output.stdout.toString("utf8");
  } catch {
    return undefined;
  }
}

export interface DiffArtifact {
  path: string;
  files: string[];
  truncated: boolean;
  bytes: number;
}

export async function buildDiffArtifact(
  workspace: string,
  runID: string,
  baseline: Record<string, BaselineFile>,
  baselineCommit: string,
  changed: string[],
  limitBytes = 1024 * 1024,
): Promise<DiffArtifact> {
  const parts: string[] = [];
  const included: string[] = [];
  let truncated = false;
  let size = 0;
  for (const path of [...changed].sort()) {
    const before = baseline[path];
    const beforeText = before === undefined ? "" : await baselineContent(workspace, baselineCommit, before);
    let afterText = "";
    try {
      const absolute = resolve(workspace, path);
      const info = await stat(absolute);
      if (info.size > MAX_SNAPSHOT_FILE_BYTES) {
        parts.push(`--- ${path}\nBinary or oversized file changed; read it directly.\n`);
        continue;
      }
      const bytes = await readFile(absolute);
      if (bytes.includes(0)) {
        parts.push(`--- ${path}\nBinary file changed.\n`);
        continue;
      }
      afterText = bytes.toString("utf8");
    } catch {
      afterText = "";
    }
    if (beforeText === undefined) {
      parts.push(`--- ${path}\nBaseline content unavailable; read the current file directly.\n`);
      continue;
    }
    const patch = createTwoFilesPatch(`a/${path}`, `b/${path}`, beforeText, afterText, "", "", { context: 3 });
    if (size + patch.length > limitBytes) {
      truncated = true;
      break;
    }
    parts.push(patch);
    included.push(path);
    size += patch.length;
  }
  if (truncated) parts.push("\n[diff truncated; review the listed changed files directly]\n");
  const evidence = await ensureArtifactDir(workspace, "evidence", runID);
  const path = join(evidence, "diff.patch");
  const content = parts.join("\n");
  await atomicWriteFile(path, content);
  return { path, files: included, truncated, bytes: Buffer.byteLength(content) };
}

export async function gitDiffStat(workspace: string, baselineCommit: string): Promise<string> {
  try {
    return await gitOutput(workspace, ["diff", "--stat", baselineCommit, "--"]);
  } catch {
    return "";
  }
}

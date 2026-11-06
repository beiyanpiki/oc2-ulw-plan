import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { UlwError } from "../core/errors.js";
import { isWithin } from "../core/spec.js";

export const ARTIFACT_SEGMENTS = [".opencode", "ulw"] as const;

export function artifactRoot(workspace: string): string {
  return resolve(workspace, ...ARTIFACT_SEGMENTS);
}

export function artifactPath(workspace: string, ...segments: string[]): string {
  return resolve(artifactRoot(workspace), ...segments);
}

export function relativeArtifactPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const marker = "/.opencode/ulw/";
  const index = normalized.lastIndexOf(marker);
  return index === -1 ? normalized : `.opencode/ulw/${normalized.slice(index + marker.length)}`;
}

export function hasSymlinkComponent(from: string, to: string): boolean {
  const rel = relative(resolve(from), resolve(to));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return true;
  let cursor = resolve(from);
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      return true;
    }
  }
  return false;
}

export function assertArtifactPath(workspace: string, target: string): string {
  const absolute = resolve(workspace, target);
  if (!isWithin(artifactRoot(workspace), absolute)) {
    throw new UlwError("ARTIFACT_OUTSIDE", `path is outside the ulw artifact root: ${target}`);
  }
  if (hasSymlinkComponent(workspace, absolute)) {
    throw new UlwError("ARTIFACT_SYMLINK", `symlink component is not allowed: ${target}`);
  }
  return absolute;
}

export async function ensureArtifactDir(workspace: string, ...segments: string[]): Promise<string> {
  const target = artifactPath(workspace, ...segments);
  const root = artifactRoot(workspace);
  if (!isWithin(root, target)) throw new UlwError("ARTIFACT_OUTSIDE", `path is outside ${root}`);
  await mkdir(target, { recursive: true });
  const realRoot = await realpath(root);
  const realTarget = await realpath(target);
  if (!isWithin(realRoot, realTarget)) throw new UlwError("ARTIFACT_SYMLINK", `directory escaped through a symlink: ${target}`);
  return target;
}

export async function atomicWriteFile(path: string, content: string | Buffer, mode = 0o600): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.${randomUUID()}.tmp`);
  const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  await writeFile(temporary, data, { mode, flag: "wx" });
  await rename(temporary, path);
}

export async function readTextFile(path: string, maxBytes = 8 * 1024): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile()) throw new UlwError("READ_NOT_FILE", `not a regular file: ${path}`);
  const data = await readFile(path);
  if (data.byteLength > maxBytes) {
    throw new UlwError("READ_TOO_LARGE", `file exceeds ${maxBytes} bytes; use pagination`);
  }
  return data.toString("utf8");
}

export async function readFilePage(path: string, offset: number, limit: number): Promise<{ text: string; next: number | null; total: number }> {
  const info = await lstat(path);
  if (!info.isFile()) throw new UlwError("READ_NOT_FILE", `not a regular file: ${path}`);
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(1, Math.min(64 * 1024, Math.floor(limit)));
  const data = await readFile(path);
  const slice = data.subarray(safeOffset, safeOffset + safeLimit);
  const next = safeOffset + slice.byteLength < data.byteLength ? safeOffset + slice.byteLength : null;
  return { text: slice.toString("utf8"), next, total: data.byteLength };
}

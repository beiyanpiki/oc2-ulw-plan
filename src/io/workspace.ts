import { realpath, stat } from "node:fs/promises";
import { UlwError } from "../core/errors.js";

export async function resolveWorkspace(input: string): Promise<string> {
  const absolute = await realpath(input).catch(() => {
    throw new UlwError("WORKSPACE_MISSING", `workspace does not exist: ${input}`);
  });
  const info = await stat(absolute);
  if (!info.isDirectory()) throw new UlwError("WORKSPACE_NOT_DIR", `workspace is not a directory: ${input}`);
  return absolute;
}

export function workspaceKey(workspace: string): string {
  return workspace.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

import { appendFile, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic } from "../core/types.js";
import { ensureArtifactDir } from "./paths.js";

export interface DiagnosticEntry {
  schema: "ulw-diagnostic/v1";
  at: number;
  workspace: string;
  sessionID?: string;
  agent?: string;
  tool: string;
  action?: string;
  code: string;
  message: string;
}

const LIMIT_BYTES = 512 * 1024;

export function diagnosticsPath(workspace: string): string {
  return join(workspace, ".opencode", "ulw", "diagnostics.jsonl");
}

function summarize(diagnostics: Diagnostic[]): string {
  return diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .slice(0, 8)
    .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
    .join(" | ");
}

export async function appendDiagnostic(workspace: string, entry: Omit<DiagnosticEntry, "schema" | "at" | "workspace">): Promise<void> {
  const path = diagnosticsPath(workspace);
  await ensureArtifactDir(workspace);
  try {
    const info = await stat(path);
    if (info.size > LIMIT_BYTES) {
      await rename(path, join(workspace, ".opencode", "ulw", "diagnostics.1.jsonl")).catch(() => undefined);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const record: DiagnosticEntry = { schema: "ulw-diagnostic/v1", at: Date.now(), workspace, ...entry };
  await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function readDiagnostics(workspace: string, limit = 20): Promise<DiagnosticEntry[]> {
  try {
    const text = await readFile(diagnosticsPath(workspace), "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .slice(-Math.max(1, limit))
      .flatMap((line) => {
        try {
          const entry = JSON.parse(line) as DiagnosticEntry;
          return entry.schema === "ulw-diagnostic/v1" ? [entry] : [];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function formatDiagnostics(entries: DiagnosticEntry[], limit = 10): string[] {
  return entries.slice(-limit).map((entry) => {
    const action = entry.action === undefined ? "" : `/${entry.action}`;
    return `- ${new Date(entry.at).toISOString()} ${entry.tool}${action} ${entry.code}: ${entry.message}`;
  });
}

export async function recordSpecDiagnostics(
  workspace: string,
  input: { sessionID?: string; agent?: string; action: string; diagnostics: Diagnostic[] },
): Promise<void> {
  const errors = input.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length === 0) return;
  await appendDiagnostic(workspace, {
    ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
    ...(input.agent === undefined ? {} : { agent: input.agent }),
    tool: "ulw_spec",
    action: input.action,
    code: errors[0]?.code ?? "SPEC_INVALID",
    message: summarize(errors),
  });
}

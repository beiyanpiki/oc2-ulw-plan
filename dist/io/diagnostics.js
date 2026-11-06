import { appendFile, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { ensureArtifactDir } from "./paths.js";
const LIMIT_BYTES = 512 * 1024;
export function diagnosticsPath(workspace) {
    return join(workspace, ".opencode", "ulw", "diagnostics.jsonl");
}
function summarize(diagnostics) {
    return diagnostics
        .filter((diagnostic) => diagnostic.severity === "error")
        .slice(0, 8)
        .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
        .join(" | ");
}
export async function appendDiagnostic(workspace, entry) {
    const path = diagnosticsPath(workspace);
    await ensureArtifactDir(workspace);
    try {
        const info = await stat(path);
        if (info.size > LIMIT_BYTES) {
            await rename(path, join(workspace, ".opencode", "ulw", "diagnostics.1.jsonl")).catch(() => undefined);
        }
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    const record = { schema: "ulw-diagnostic/v1", at: Date.now(), workspace, ...entry };
    await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}
export async function readDiagnostics(workspace, limit = 20) {
    try {
        const text = await readFile(diagnosticsPath(workspace), "utf8");
        return text
            .split("\n")
            .filter((line) => line.trim() !== "")
            .slice(-Math.max(1, limit))
            .flatMap((line) => {
            try {
                const entry = JSON.parse(line);
                return entry.schema === "ulw-diagnostic/v1" ? [entry] : [];
            }
            catch {
                return [];
            }
        });
    }
    catch (error) {
        if (error.code === "ENOENT")
            return [];
        throw error;
    }
}
export function formatDiagnostics(entries, limit = 10) {
    return entries.slice(-limit).map((entry) => {
        const action = entry.action === undefined ? "" : `/${entry.action}`;
        return `- ${new Date(entry.at).toISOString()} ${entry.tool}${action} ${entry.code}: ${entry.message}`;
    });
}
export async function recordSpecDiagnostics(workspace, input) {
    const errors = input.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length === 0)
        return;
    await appendDiagnostic(workspace, {
        ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        tool: "ulw_spec",
        action: input.action,
        code: errors[0]?.code ?? "SPEC_INVALID",
        message: summarize(errors),
    });
}
//# sourceMappingURL=diagnostics.js.map
import { analyzeSpec, lintSpec, verifySpecPaths } from "../core/spec.js";
import type { ActiveRun, RoleInvocation, RunRecord, SpecRecord } from "../core/types.js";
import { formatDiagnostics, readDiagnostics } from "../io/diagnostics.js";
import { pidAlive, readLock } from "../io/lock.js";
import { Runtime } from "./runtime.js";

/**
 * Host-side snapshot used for monitoring a workspace. It combines the plugin
 * store (specs, runs, role invocations) with the on-disk lock, spec files and
 * diagnostics journal so a stuck or interrupted flow can be diagnosed without
 * reading OpenCode's private database.
 */
export class DiagnoseService {
  constructor(private readonly runtime: Runtime) {}

  private async ownerState(sessionID: string, cache: Map<string, string>): Promise<string> {
    const cached = cache.get(sessionID);
    if (cached !== undefined) return cached;
    const session = await this.runtime.session(sessionID).catch(() => undefined);
    let state: string;
    if (session === undefined) state = "missing";
    else if (session.outcome !== undefined) state = session.outcome;
    else {
      const busy = session.time?.busy !== undefined && (session.time.idle === undefined || session.time.busy > session.time.idle);
      state = busy ? "busy" : "idle";
    }
    cache.set(sessionID, state);
    return state;
  }

  async report(sessionID: string, limit: number): Promise<{ text: string; metadata: Record<string, unknown> }> {
    const { workspace } = await this.runtime.workspaceOfSession(sessionID);
    const store = this.runtime.store(workspace);
    const specs = (await store.listSpecs<SpecRecord>()).map((entry) => entry.value).sort((left, right) => right.updatedAt - left.updatedAt);
    const runs = (await store.listRuns<RunRecord>())
      .map((entry) => entry.value)
      .filter((run) => run.workspace === workspace)
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const invocations = (await store.listInvocations<RoleInvocation>())
      .map((entry) => entry.value)
      .filter((invocation) => invocation.workspace === workspace)
      .sort((left, right) => right.createdAt - left.createdAt);
    const active = await store.getActive<ActiveRun>(sessionID);
    let lock: Awaited<ReturnType<typeof readLock>>;
    try {
      lock = await readLock(workspace);
    } catch {
      lock = undefined;
    }
    const diagnostics = await readDiagnostics(workspace, limit).catch(() => []);
    const owners = new Map<string, string>();
    const warnings: string[] = [];
    if (lock === undefined) {
      // The lock is optional; a malformed file is reported as a warning only when
      // the actual file exists (readLock throws in that case).
      try {
        await readLock(workspace);
      } catch {
        warnings.push("workspace lock exists but cannot be parsed");
      }
    }
    const lines = [
      "# ulw diagnose",
      `workspace: ${workspace}`,
      `active run for this session: ${active?.runID ?? "none"}`,
    ];

    lines.push("", "## Specs");
    if (specs.length === 0) lines.push("- none");
    for (const record of specs) {
      const file = await this.runtime.loadSpec(record.id, workspace);
      let validity = "file missing";
      if (file !== undefined) {
        const analysis = analyzeSpec(file.content);
        const diagnosticsForSpec = [...analysis.diagnostics, ...(analysis.parsed === undefined ? [] : lintSpec(analysis.parsed, record.strict === true))];
        if (analysis.parsed !== undefined) diagnosticsForSpec.push(...(await verifySpecPaths(analysis.parsed.spec, workspace)));
        const errors = diagnosticsForSpec.filter((entry) => entry.severity === "error");
        validity = errors.length === 0 ? "valid" : `INVALID: ${errors.slice(0, 3).map((entry) => entry.code).join(", ")}`;
        if (analysis.hash !== record.contentHash) validity += " (record stale)";
        if (errors.length > 0) warnings.push(`spec ${record.id} has ${errors.length} validation error(s)`);
      }
      lines.push(
        `- ${record.id}: status=${record.status} risk=${record.risk} strict=${record.strict === true ? "yes" : "no"} practical=${record.practical?.verdict ?? "none"} adversarial=${record.adversarial?.verdict ?? "none"} ${validity}`,
      );
    }

    lines.push("", "## Runs");
    if (runs.length === 0) lines.push("- none");
    for (const run of runs.slice(0, 20)) {
      const owner = await this.ownerState(run.ownerSessionID, owners);
      const blocked = Object.values(run.tasks).filter((task) => task.status === "blocked");
      lines.push(`- ${run.id}: ${run.status} spec=${run.specId} owner=${run.ownerSessionID} (${owner}) tasks=${Object.values(run.tasks).map((task) => `${task.id}:${task.status}`).join(" ")}`);
      for (const task of blocked) lines.push(`  - ${task.id} blocked: ${task.blockedReason ?? "no reason recorded"}`);
      if ((run.status === "running" || run.status === "final_verification") && (owner === "idle" || owner === "interrupted" || owner === "missing")) {
        warnings.push(`run ${run.id} is ${run.status} but its owner session is ${owner}; recover it with /ulw-execute --recover ${run.specId} --takeover`);
      }
    }

    lines.push("", `## Roles (last ${Math.min(20, invocations.length)})`);
    if (invocations.length === 0) lines.push("- none");
    for (const invocation of invocations.slice(0, 20)) {
      lines.push(
        `- ${invocation.role}: ${invocation.status} spec=${invocation.specId ?? "-"} run=${invocation.runId ?? "-"} task=${invocation.taskId ?? "-"} target=${invocation.targetHash?.slice(0, 12) ?? "-"}${invocation.error === undefined ? "" : ` error=${invocation.error}`}`,
      );
      if (invocation.status === "failed" && invocation.error === "role finished without submitting ulw_report") {
        warnings.push(`${invocation.role} ${invocation.id} finished without a report`);
      }
    }

    lines.push("", "## Lock");
    if (lock === undefined) lines.push("- none");
    else {
      const alive = pidAlive(lock.pid);
      lines.push(`- run=${lock.runID} session=${lock.sessionID} pid=${lock.pid} (${alive ? "alive" : "gone"}) since ${new Date(lock.acquiredAt).toISOString()}`);
      if (!alive) warnings.push(`workspace lock is stale (pid ${lock.pid} is gone)`);
    }

    lines.push("", "## Recent diagnostics");
    if (diagnostics.length === 0) lines.push("- none");
    else lines.push(...formatDiagnostics(diagnostics, limit));

    if (warnings.length > 0) {
      lines.push("", "## Warnings");
      for (const warning of warnings) lines.push(`- ${warning}`);
    }

    return {
      text: lines.join("\n"),
      metadata: {
        workspace,
        specs: specs.length,
        runs: runs.length,
        invocations: invocations.length,
        diagnostics: diagnostics.length,
        warnings: warnings.length,
      },
    };
  }
}

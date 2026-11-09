import { analyzeSpec, lintSpec, verifySpecPaths } from "../core/spec.js";
import { roleBudget } from "../core/roles.js";
import { formatDiagnostics, readDiagnostics } from "../io/diagnostics.js";
import { pidAlive, readLock } from "../io/lock.js";
/**
 * Host-side snapshot used for monitoring a workspace. It combines the plugin
 * store (specs, runs, role invocations) with the on-disk lock, spec files and
 * diagnostics journal so a stuck or interrupted flow can be diagnosed without
 * reading OpenCode's private database.
 */
export class DiagnoseService {
    runtime;
    constructor(runtime) {
        this.runtime = runtime;
    }
    async ownerState(sessionID, cache) {
        const cached = cache.get(sessionID);
        if (cached !== undefined)
            return cached;
        const session = await this.runtime.session(sessionID).catch(() => undefined);
        let state;
        if (session === undefined)
            state = "missing";
        else if (session.outcome !== undefined)
            state = session.outcome;
        else {
            const busy = session.time?.busy !== undefined && (session.time.idle === undefined || session.time.busy > session.time.idle);
            state = busy ? "busy" : "idle";
        }
        cache.set(sessionID, state);
        return state;
    }
    async report(sessionID, limit) {
        const { workspace } = await this.runtime.workspaceOfSession(sessionID);
        const store = this.runtime.store(workspace);
        const specs = (await store.listSpecs()).map((entry) => entry.value).sort((left, right) => right.updatedAt - left.updatedAt);
        const runs = (await store.listRuns())
            .map((entry) => entry.value)
            .filter((run) => run.workspace === workspace)
            .sort((left, right) => right.updatedAt - left.updatedAt);
        const invocations = (await store.listInvocations())
            .map((entry) => entry.value)
            .filter((invocation) => invocation.workspace === workspace)
            .sort((left, right) => right.createdAt - left.createdAt);
        const active = await store.getActive(sessionID);
        const grants = (await store.listBudgetGrants()).map((entry) => entry.value);
        let lock;
        try {
            lock = await readLock(workspace);
        }
        catch {
            lock = undefined;
        }
        const diagnostics = await readDiagnostics(workspace, limit).catch(() => []);
        const owners = new Map();
        const warnings = [];
        if (lock === undefined) {
            // The lock is optional; a malformed file is reported as a warning only when
            // the actual file exists (readLock throws in that case).
            try {
                await readLock(workspace);
            }
            catch {
                warnings.push("workspace lock exists but cannot be parsed");
            }
        }
        const lines = [
            "# ulw diagnose",
            `workspace: ${workspace}`,
            `active run for this session: ${active?.runID ?? "none"}`,
        ];
        lines.push("", "## Specs");
        if (specs.length === 0)
            lines.push("- none");
        for (const record of specs) {
            const file = await this.runtime.loadSpec(record.id, workspace);
            let validity = "file missing";
            if (file !== undefined) {
                const analysis = analyzeSpec(file.content);
                const diagnosticsForSpec = [...analysis.diagnostics, ...(analysis.parsed === undefined ? [] : lintSpec(analysis.parsed, record.strict === true))];
                if (analysis.parsed !== undefined)
                    diagnosticsForSpec.push(...(await verifySpecPaths(analysis.parsed.spec, workspace)));
                const errors = diagnosticsForSpec.filter((entry) => entry.severity === "error");
                validity = errors.length === 0 ? "valid" : `INVALID: ${errors.slice(0, 3).map((entry) => entry.code).join(", ")}`;
                if (analysis.hash !== record.contentHash)
                    validity += " (record stale)";
                if (errors.length > 0)
                    warnings.push(`spec ${record.id} has ${errors.length} validation error(s)`);
            }
            lines.push(`- ${record.id}: status=${record.status} risk=${record.risk} strict=${record.strict === true ? "yes" : "no"} practical=${record.practical?.verdict ?? "none"} adversarial=${record.adversarial?.verdict ?? "none"} ${validity}`);
            for (const role of ["practical-reviewer", "adversarial-reviewer"]) {
                const budget = roleBudget(invocations.map((value) => ({ id: value.id, value })), role, { workspace, specId: record.id });
                const available = grants.filter((grant) => grant.specId === record.id && grant.role === role && grant.parentSessionID === sessionID && grant.targetHash === record.contentHash && grant.consumedBy === undefined).length;
                lines.push(`  - ${role} budget: reports=${budget.reports}/${budget.maxReports} attempts=${budget.attempts}/${budget.maxAttempts} grants-used=${budget.grantsUsed} grants-available=${available}`);
                if (budget.reports >= budget.maxReports || budget.attempts >= budget.maxAttempts) {
                    lines.push(`    user may authorize one extra attempt: /ulw-review-budget ${record.id} --role ${role} --reason "reason"`);
                }
            }
        }
        lines.push("", "## Runs");
        if (runs.length === 0)
            lines.push("- none");
        for (const run of runs.slice(0, 20)) {
            const owner = await this.ownerState(run.ownerSessionID, owners);
            const blocked = Object.values(run.tasks).filter((task) => task.status === "blocked");
            lines.push(`- ${run.id}: ${run.status} spec=${run.specId} owner=${run.ownerSessionID} (${owner}) tasks=${Object.values(run.tasks).map((task) => `${task.id}:${task.status}`).join(" ")}`);
            for (const task of blocked)
                lines.push(`  - ${task.id} blocked: ${task.blockedReason ?? "no reason recorded"}`);
            if ((run.status === "running" || run.status === "final_verification") && (owner === "idle" || owner === "interrupted" || owner === "missing")) {
                warnings.push(`run ${run.id} is ${run.status} but its owner session is ${owner}; recover it with /ulw-execute --recover ${run.specId} --takeover`);
            }
        }
        lines.push("", `## Roles (last ${Math.min(20, invocations.length)})`);
        if (invocations.length === 0)
            lines.push("- none");
        for (const invocation of invocations.slice(0, 20)) {
            lines.push(`- ${invocation.role}: ${invocation.status} id=${invocation.id} spec=${invocation.specId ?? "-"} run=${invocation.runId ?? "-"} task=${invocation.taskId ?? "-"} target=${invocation.targetHash?.slice(0, 12) ?? "-"} model=${invocation.model === undefined ? "legacy/Host default" : `${invocation.model.providerID}/${invocation.model.id}${invocation.model.variant === undefined ? "" : `#${invocation.model.variant}`}`}${invocation.error === undefined ? "" : ` error=${invocation.error}`}`);
            if (invocation.status === "failed" && invocation.error === "role finished without submitting ulw_report") {
                warnings.push(`${invocation.role} ${invocation.id} finished without a report`);
            }
        }
        if (grants.length > 0) {
            lines.push("", "## Review budget grants");
            for (const grant of grants.sort((left, right) => right.createdAt - left.createdAt).slice(0, 20)) {
                lines.push(`- ${grant.id}: ${grant.role} spec=${grant.specId} target=${grant.targetHash.slice(0, 12)} session=${grant.parentSessionID} consumed=${grant.consumedBy ?? "no"} reason=${grant.reason}`);
            }
        }
        lines.push("", "## Lock");
        if (lock === undefined)
            lines.push("- none");
        else {
            const alive = pidAlive(lock.pid);
            lines.push(`- run=${lock.runID} session=${lock.sessionID} pid=${lock.pid} (${alive ? "alive" : "gone"}) since ${new Date(lock.acquiredAt).toISOString()}`);
            if (!alive)
                warnings.push(`workspace lock is stale (pid ${lock.pid} is gone)`);
        }
        lines.push("", "## Recent diagnostics");
        if (diagnostics.length === 0)
            lines.push("- none");
        else
            lines.push(...formatDiagnostics(diagnostics, limit));
        if (warnings.length > 0) {
            lines.push("", "## Warnings");
            for (const warning of warnings)
                lines.push(`- ${warning}`);
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
//# sourceMappingURL=diagnose-service.js.map
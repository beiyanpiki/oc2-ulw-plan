import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { UlwError } from "../core/errors.js";
import { parseSpec, verifySpecPaths } from "../core/spec.js";
import { allTasksChecked, blockTask as blockTaskCore, checkpointTask as checkpointTaskCore, claimTask as claimTaskCore, completeRun, createRun, loadRun, newRunID, recordTaskFailure, requireOwner, saveRun, setRunStatus, taskScope } from "../core/run.js";
import { loadSpecRecord, publishCheck, requireRequiredAdversarial, verifyPlanReview } from "../core/spec-record.js";
import { evaluateExpectation, persistCommandEvidence, runProcess } from "../core/evidence.js";
import { acquireLock, inspectRecoverable, releaseLock, transferLock } from "../io/lock.js";
import { artifactPath, ensureArtifactDir, atomicWriteFile } from "../io/paths.js";
import { buildDiffArtifact, captureBaseline, fingerprintWorkspace, isGitWorkspace, statusEntries } from "../io/repository.js";
export class RunService {
    runtime;
    constructor(runtime) {
        this.runtime = runtime;
    }
    async resolveWorkspace(sessionID, runID) {
        const { workspace: canonical } = await this.runtime.workspaceOfSession(sessionID);
        const active = await this.runtime.store(canonical).getActive(sessionID);
        if (active !== undefined && active.schema === "ulw-active-run/v1" && (runID === undefined || active.runID === runID)) {
            return active.workspace;
        }
        return canonical;
    }
    async workspaceForSession(sessionID) {
        return this.resolveWorkspace(sessionID);
    }
    async workspaceForSessionRun(sessionID, runID) {
        return this.resolveWorkspace(sessionID, runID);
    }
    async start(input) {
        const { workspace: sessionWorkspace } = await this.runtime.workspaceOfSession(input.sessionID);
        const workspace = input.workspace ?? sessionWorkspace;
        const canonicalWorkspace = input.sessionWorkspace ?? sessionWorkspace;
        const store = this.runtime.store(workspace);
        const record = await loadSpecRecord(store, input.specId);
        if (record.status !== "ready")
            throw new UlwError("SPEC_NOT_READY", `spec is ${record.status}; publish it first`);
        const file = await this.runtime.loadSpec(input.specId, workspace);
        if (file === undefined)
            throw new UlwError("SPEC_NOT_FOUND", `no spec file: ${input.specId}`);
        const parsed = parseSpec(file.content);
        const diagnostics = await verifySpecPaths(parsed.spec, workspace);
        if (diagnostics.some((entry) => entry.severity === "error"))
            throw new UlwError("SPEC_INVALID", "source files failed validation");
        if (record.contentHash !== parsed.sha256)
            throw new UlwError("SPEC_STALE", "spec changed after publication");
        const publish = publishCheck(record, parsed, record.requireAdversarial);
        if (!publish.ok)
            throw new UlwError("SPEC_NOT_APPROVED", publish.missing.join("; "));
        const practical = await verifyPlanReview(store, record, "practical");
        if (!practical.ok)
            throw new UlwError("SPEC_NOT_APPROVED", practical.reason);
        if (requireRequiredAdversarial(record, parsed, record.requireAdversarial)) {
            const adversarial = await verifyPlanReview(store, record, "adversarial");
            if (!adversarial.ok)
                throw new UlwError("SPEC_NOT_APPROVED", adversarial.reason);
        }
        const actualSources = {};
        const { computeSourceHashes } = await import("../core/spec.js");
        Object.assign(actualSources, await computeSourceHashes(parsed.spec, workspace));
        for (const [path, hash] of Object.entries(record.sourceHashes)) {
            if (actualSources[path] !== hash)
                throw new UlwError("SOURCE_STALE", `source changed after publication: ${path}`);
        }
        if (!(await isGitWorkspace(workspace)))
            throw new UlwError("NOT_GIT", "execution requires a Git worktree");
        const dirty = await statusEntries(workspace);
        const productDirty = dirty.filter((entry) => !entry.path.startsWith(".opencode/ulw/"));
        const taskFiles = new Set(parsed.spec.tasks.flatMap((task) => task.files));
        const overlap = productDirty.filter((entry) => taskFiles.has(entry.path) || (entry.originalPath !== undefined && taskFiles.has(entry.originalPath)));
        if (overlap.length > 0) {
            throw new UlwError("DIRTY_OVERLAP", `uncommitted user changes overlap task files: ${overlap.map((entry) => entry.path).join(", ")}`);
        }
        const runID = newRunID();
        const lock = await acquireLock(workspace, { sessionID: input.sessionID, runID });
        try {
            const baseline = await captureBaseline(workspace, runID);
            const evidenceDir = await ensureArtifactDir(workspace, "evidence", runID);
            const run = createRun({
                spec: parsed.spec,
                specHash: parsed.sha256,
                sourceHashes: actualSources,
                workspace,
                projectID: input.projectID,
                ownerSessionID: input.sessionID,
                ownerAgent: input.agent,
                baselineCommit: baseline.commit,
                baselineFiles: baseline.files,
                lockToken: lock.token,
                evidenceDir,
            });
            run.id = runID;
            await saveRun(store, run);
            await this.markReviewInvocations(store, run, parsed);
            await this.runtime.store(canonicalWorkspace).setActive(input.sessionID, {
                schema: "ulw-active-run/v1",
                sessionID: input.sessionID,
                runID: run.id,
                workspace,
                specId: parsed.spec.id,
                updatedAt: Date.now(),
            });
            return run;
        }
        catch (error) {
            await releaseLock(workspace, lock.token);
            throw error;
        }
    }
    async markReviewInvocations(store, run, parsed) {
        const invocations = await store.listInvocations();
        for (const entry of invocations.map((item) => item.value)) {
            if (entry.specId !== parsed.spec.id || entry.targetHash !== parsed.sha256 || entry.status !== "completed")
                continue;
            if (entry.role === "practical-reviewer" || entry.role === "adversarial-reviewer") {
                run.reviewInvocations[entry.role] = entry.id;
            }
        }
        await saveRun(store, run);
    }
    async resume(runID, sessionID, workspaceOverride) {
        const { workspace: sessionWorkspace } = await this.runtime.workspaceOfSession(sessionID);
        const workspace = workspaceOverride ?? (await this.resolveWorkspace(sessionID, runID));
        const store = this.runtime.store(workspace);
        const run = await loadRun(store, runID);
        requireOwner(run, sessionID);
        if (run.status === "succeeded")
            throw new UlwError("RUN_DONE", "run already succeeded");
        if (run.status === "stale")
            throw new UlwError("RUN_STALE", "run is stale; create a new run");
        const file = await this.runtime.loadSpec(run.specId, workspace);
        if (file === undefined)
            throw new UlwError("SPEC_NOT_FOUND", "spec file is missing");
        const parsed = parseSpec(file.content);
        if (parsed.sha256 !== run.specHash) {
            await setRunStatus(store, run, "stale", "spec changed while the run was paused");
            throw new UlwError("SPEC_STALE", "spec changed while the run was paused");
        }
        const decision = await inspectRecoverable(workspace, sessionID, runID);
        if (!decision.recoverable)
            throw new UlwError("RUN_LOCKED", decision.reason);
        let token = "";
        if (decision.lock === undefined) {
            const lock = await acquireLock(workspace, { sessionID, runID });
            token = lock.token;
        }
        else {
            const transferred = await transferLock(workspace, decision.lock, sessionID, runID);
            token = transferred.token;
        }
        run.lockToken = token;
        run.status = "running";
        delete run.pauseReason;
        const nowFingerprint = await fingerprintWorkspace(workspace, run.baselineFiles, run.baselineCommit);
        for (const task of Object.values(run.tasks)) {
            if ((task.status === "checked" || task.status === "passed") && task.fingerprint !== nowFingerprint.fingerprint) {
                task.status = "pending";
                delete task.fingerprint;
                delete task.checkedAt;
            }
        }
        await saveRun(store, run);
        await this.runtime.store(sessionWorkspace).setActive(sessionID, {
            schema: "ulw-active-run/v1",
            sessionID,
            runID: run.id,
            workspace,
            specId: run.specId,
            updatedAt: Date.now(),
        });
        return run;
    }
    async status(runID, sessionID) {
        const workspace = await this.resolveWorkspace(sessionID, runID);
        const store = this.runtime.store(workspace);
        const run = await loadRun(store, runID);
        const evidence = await store.listEvidence(runID);
        const invocations = await store.listInvocations();
        const final = invocations.map((entry) => entry.value).filter((entry) => entry.runId === runID);
        const lines = [
            `# ulw run ${run.id}`,
            `spec: ${run.specId} (${run.specHash.slice(0, 12)})`,
            `status: ${run.status}`,
            `workspace: ${workspace}`,
            `attempts: ${Object.values(run.tasks).reduce((sum, task) => sum + task.attempts, 0)}`,
            "",
            "## Tasks",
            ...Object.values(run.tasks).map((task) => `- ${task.id}: ${task.status}${task.fingerprint ? ` @ ${task.fingerprint.slice(0, 8)}` : ""}${task.blockedReason ? ` - ${task.blockedReason}` : ""}`),
            "",
            "## Evidence",
            ...(evidence.length === 0
                ? ["- none"]
                : evidence.map((entry) => `- ${entry.value.taskId}/${entry.value.checkId}: ${entry.value.passed ? "passed" : "failed"} (${entry.value.summary})`)),
            "",
            "## Roles",
            ...(final.length === 0 ? ["- none"] : final.map((entry) => `- ${entry.role}: ${entry.status}${entry.targetHash ? ` @ ${entry.targetHash.slice(0, 8)}` : ""}`)),
            "",
            "## Next",
            run.status === "paused" ? `- resume: /ulw-execute ${run.specId} --resume ${run.id}` : run.status === "final_verification" ? "- run ulw_role verifier and code-reviewer, then ulw_run action=finalize" : run.status === "blocked" ? `- inspect ${run.failureReason ?? "the blocked task"} or reopen a task` : "- continue ready tasks with ulw_run action=claim and ulw_check",
        ];
        return { run, text: lines.join("\n") };
    }
    async findSessionRun(workspace, sessionID) {
        const store = this.runtime.store(workspace);
        const active = await store.getActive(sessionID);
        if (active !== undefined && active.schema === "ulw-active-run/v1") {
            const run = await this.runtime.store(active.workspace).getRun(active.runID);
            if (run !== undefined && run.ownerSessionID === sessionID)
                return run;
        }
        const runs = await store.listRuns();
        return runs.map((entry) => entry.value).filter((run) => run.ownerSessionID === sessionID).sort((left, right) => right.updatedAt - left.updatedAt)[0];
    }
    async findActiveRun(workspace, sessionID) {
        const store = this.runtime.store(workspace);
        const active = await store.getActive(sessionID);
        if (active !== undefined && active.schema === "ulw-active-run/v1") {
            const target = this.runtime.store(active.workspace);
            const run = await target.getRun(active.runID);
            if (run !== undefined && run.ownerSessionID === sessionID && (run.status === "running" || run.status === "final_verification"))
                return run;
        }
        const runs = await store.listRuns();
        return runs.map((entry) => entry.value).find((run) => run.ownerSessionID === sessionID && (run.status === "running" || run.status === "final_verification"));
    }
    async claim(runID, taskID, sessionID) {
        const workspace = await this.resolveWorkspace(sessionID, runID);
        const store = this.runtime.store(workspace);
        const run = await loadRun(store, runID);
        const file = await this.runtime.loadSpec(run.specId, workspace);
        if (file === undefined)
            throw new UlwError("SPEC_NOT_FOUND", "spec file is missing");
        const parsed = parseSpec(file.content);
        return this.runtime.withMutex(`run:${workspace}`, () => claimTaskCore(store, run, parsed.spec, taskID, sessionID));
    }
    async checkpoint(runID, taskID, sessionID) {
        const workspace = await this.resolveWorkspace(sessionID, runID);
        const store = this.runtime.store(workspace);
        const run = await loadRun(store, runID);
        const file = await this.runtime.loadSpec(run.specId, workspace);
        if (file === undefined)
            throw new UlwError("SPEC_NOT_FOUND", "spec file is missing");
        const parsed = parseSpec(file.content);
        const fingerprint = await fingerprintWorkspace(workspace, run.baselineFiles, run.baselineCommit);
        const task = parsed.spec.tasks.find((entry) => entry.id === taskID);
        if (task === undefined)
            throw new UlwError("TASK_NOT_FOUND", `no task: ${taskID}`);
        const taskChanged = fingerprint.dirtyFiles.filter((path) => task.files.includes(path));
        const evidence = await store.listEvidence(runID);
        const current = evidence.map((entry) => entry.value);
        const updated = await this.runtime.withMutex(`run:${workspace}`, () => checkpointTaskCore(store, run, parsed.spec, taskID, fingerprint.fingerprint, taskChanged, current));
        return { run: updated, evidence: current };
    }
    async block(runID, taskID, reason, sessionID) {
        const workspace = await this.resolveWorkspace(sessionID, runID);
        const store = this.runtime.store(workspace);
        const run = await loadRun(store, runID);
        requireOwner(run, sessionID);
        return this.runtime.withMutex(`run:${workspace}`, () => blockTaskCore(store, run, taskID, reason));
    }
    async pause(runID, sessionID, reason) {
        const workspace = await this.resolveWorkspace(sessionID, runID);
        const store = this.runtime.store(workspace);
        const run = await loadRun(store, runID);
        requireOwner(run, sessionID);
        const updated = await setRunStatus(store, run, "paused", reason ?? "user paused the run");
        await releaseLock(workspace, run.lockToken);
        return updated;
    }
    async freeze(runID, sessionID) {
        const workspace = await this.resolveWorkspace(sessionID, runID);
        const store = this.runtime.store(workspace);
        const run = await loadRun(store, runID);
        requireOwner(run, sessionID);
        if (run.status !== "running")
            throw new UlwError("RUN_STATE", `run is ${run.status}, not running`);
        if (!allTasksChecked(run))
            throw new UlwError("TASKS_INCOMPLETE", "all tasks must be checked before final verification");
        const file = await this.runtime.loadSpec(run.specId, workspace);
        if (file === undefined)
            throw new UlwError("SPEC_NOT_FOUND", "spec file is missing");
        const parsed = parseSpec(file.content);
        if (parsed.sha256 !== run.specHash)
            throw new UlwError("SPEC_STALE", "spec changed after the run started");
        const fingerprint = await fingerprintWorkspace(workspace, run.baselineFiles, run.baselineCommit);
        const allowed = taskScope(parsed.spec);
        const outside = fingerprint.dirtyFiles.filter((path) => !allowed.has(path));
        if (outside.length > 0)
            throw new UlwError("UNATTRIBUTED_CHANGES", `product changes outside every task scope: ${outside.join(", ")}`);
        const diff = await buildDiffArtifact(workspace, run.id, run.baselineFiles, run.baselineCommit, fingerprint.dirtyFiles);
        run.verificationFingerprint = fingerprint.fingerprint;
        run.finalDiffPath = diff.path;
        run.status = "final_verification";
        await saveRun(store, run);
        return { run, diff: diff.path, changed: fingerprint.dirtyFiles };
    }
    async reopen(runID, taskID, sessionID, reason) {
        const workspace = await this.resolveWorkspace(sessionID, runID);
        const store = this.runtime.store(workspace);
        const run = await loadRun(store, runID);
        requireOwner(run, sessionID);
        if (run.status !== "final_verification" && run.status !== "running" && run.status !== "blocked") {
            throw new UlwError("RUN_STATE", `run is ${run.status}; no task can be reopened`);
        }
        const task = run.tasks[taskID];
        if (task === undefined)
            throw new UlwError("TASK_NOT_FOUND", `no task: ${taskID}`);
        if (task.status !== "blocked" && task.status !== "checked" && task.status !== "passed") {
            throw new UlwError("TASK_STATE", `task ${taskID} is ${task.status}, not blocked or checked`);
        }
        task.status = "pending";
        delete task.fingerprint;
        delete task.checkedAt;
        if (reason === undefined)
            delete task.blockedReason;
        else
            task.blockedReason = reason;
        if (run.status === "final_verification") {
            delete run.verificationFingerprint;
            delete run.finalDiffPath;
            run.finalInvocations = {};
        }
        run.status = "running";
        await saveRun(store, run);
        return run;
    }
    async finalize(runID, sessionID) {
        const workspace = await this.resolveWorkspace(sessionID, runID);
        const store = this.runtime.store(workspace);
        const run = await loadRun(store, runID);
        requireOwner(run, sessionID);
        if (run.status !== "final_verification")
            throw new UlwError("RUN_STATE", `run is ${run.status}, not final_verification`);
        if (run.verificationFingerprint === undefined)
            throw new UlwError("RUN_NOT_FROZEN", "run has no verification fingerprint");
        const file = await this.runtime.loadSpec(run.specId, workspace);
        if (file === undefined)
            throw new UlwError("SPEC_NOT_FOUND", "spec file is missing");
        const parsed = parseSpec(file.content);
        const fingerprint = await fingerprintWorkspace(workspace, run.baselineFiles, run.baselineCommit);
        if (fingerprint.fingerprint !== run.verificationFingerprint)
            throw new UlwError("CODE_STALE", "product code changed after final verification started; reopen the affected task");
        const invocations = await store.listInvocations();
        const pick = (role) => invocations
            .map((entry) => entry.value)
            .filter((entry) => entry.runId === run.id && entry.role === role && entry.status === "completed" && entry.targetHash === run.verificationFingerprint)
            .sort((left, right) => right.createdAt - left.createdAt)[0];
        const verifier = pick("verifier");
        const reviewer = pick("code-reviewer");
        if (verifier?.reportId === undefined)
            throw new UlwError("VERIFIER_MISSING", "no completed verifier report for this code version");
        if (reviewer?.reportId === undefined)
            throw new UlwError("CODE_REVIEW_MISSING", "no completed code-reviewer report for this code version");
        const verifierReport = await store.getReport(verifier.reportId);
        const codeReport = await store.getReport(reviewer.reportId);
        if (verifierReport === undefined || codeReport === undefined)
            throw new UlwError("REPORT_NOT_FOUND", "final report record is missing");
        const report = await this.generateReport(run, parsed, fingerprint.dirtyFiles, verifierReport.payload, codeReport.payload);
        const reportPath = artifactPath(workspace, "reports", `${run.id}.md`);
        await ensureArtifactDir(workspace, "reports");
        await atomicWriteFile(reportPath, report);
        const completed = await completeRun(store, {
            run,
            spec: parsed.spec,
            currentSpecHash: parsed.sha256,
            currentFingerprint: fingerprint.fingerprint,
            changedFiles: fingerprint.dirtyFiles,
            verifierInvocation: { targetHash: verifier.targetHash, status: verifier.status, reportId: verifier.reportId },
            codeInvocation: { targetHash: reviewer.targetHash, status: reviewer.status, reportId: reviewer.reportId },
            verifierReport: { ...(verifierReport.targetHash === undefined ? {} : { targetHash: verifierReport.targetHash }), role: "verifier", payload: verifierReport.payload },
            codeReport: { ...(codeReport.targetHash === undefined ? {} : { targetHash: codeReport.targetHash }), role: "code-reviewer", payload: codeReport.payload },
            reportPath,
        });
        await releaseLock(workspace, run.lockToken);
        return { run: completed, report };
    }
    async generateReport(run, parsed, changed, verifier, reviewer) {
        const lines = [
            `# ulw execution report: ${run.id}`,
            "",
            `- spec: ${run.specId}`,
            `- spec sha256: ${run.specHash}`,
            `- code fingerprint: ${run.verificationFingerprint ?? ""}`,
            `- status: succeeded`,
            `- workspace: ${run.workspace}`,
            "",
            "## Requirements",
            ...parsed.spec.requirements.map((requirement) => `- ${requirement.id}: ${requirement.text}`),
            "",
            "## Tasks",
            ...Object.values(run.tasks).map((task) => `- ${task.id}: ${task.status}; attempts ${task.attempts}; files ${task.changedFiles.join(", ") || "(none)"}`),
            "",
            "## Changed files",
            ...(changed.length === 0 ? ["- none"] : changed.map((path) => `- ${path}`)),
            "",
            "## Verifier",
            "```json",
            JSON.stringify(verifier, null, 2),
            "```",
            "",
            "## Code review",
            "```json",
            JSON.stringify(reviewer, null, 2),
            "```",
            "",
            `Generated at ${new Date().toISOString()}.`,
        ];
        return `${lines.join("\n")}\n`;
    }
    async runDir(workspace) {
        const root = artifactPath(workspace, "reports");
        try {
            return (await readdir(root)).filter((entry) => entry.endsWith(".md"));
        }
        catch {
            return [];
        }
    }
    async check(input, sessionID, signal, assertPermission) {
        const { workspace: sessionWorkspace } = await this.runtime.workspaceOfSession(sessionID);
        const sessionStore = this.runtime.store(sessionWorkspace);
        const active = await sessionStore.getActive(sessionID);
        const sessionBinding = await sessionStore.getBinding(sessionID);
        const runId = input.runId ?? sessionBinding?.runId ?? active?.runID;
        if (runId === undefined)
            throw new UlwError("RUN_REQUIRED", "ulw_check needs a run id or an active role binding");
        const workspace = active?.runID === runId ? active.workspace : await this.resolveWorkspace(sessionID, runId);
        const store = this.runtime.store(workspace);
        const roleBinding = workspace === sessionWorkspace ? sessionBinding : await store.getBinding(sessionID);
        const run = await loadRun(store, runId);
        if (roleBinding !== undefined && roleBinding.role !== "verifier" && roleBinding.role !== "worker") {
            throw new UlwError("CHECK_ROLE", `${roleBinding.role ?? "role"} may not run checks`);
        }
        if (roleBinding === undefined) {
            requireOwner(run, sessionID);
        }
        else {
            const binding = await store.getBinding(sessionID);
            if (binding?.invocationID === undefined)
                throw new UlwError("ROLE_UNBOUND", "role check has no bound invocation");
            const invocation = await store.getInvocation(binding.invocationID);
            if (invocation?.status !== "running")
                throw new UlwError("ROLE_CLOSED", `role invocation is ${invocation?.status ?? "missing"}`);
        }
        if (run.status !== "running" && run.status !== "final_verification")
            throw new UlwError("RUN_STATE", `run is ${run.status}`);
        const taskID = input.taskId ?? roleBinding?.taskId;
        const file = await this.runtime.loadSpec(run.specId, workspace);
        if (file === undefined)
            throw new UlwError("SPEC_NOT_FOUND", "spec file is missing");
        const parsed = parseSpec(file.content);
        const check = parsed.spec.checks.find((entry) => entry.id === input.checkId);
        if (check === undefined)
            throw new UlwError("CHECK_NOT_FOUND", `no check: ${input.checkId}`);
        if (check.type !== "command")
            throw new UlwError("CHECK_PROCEDURE", "procedure checks are verified by the independent verifier report");
        let task = taskID === undefined ? parsed.spec.tasks.find((entry) => entry.checks.includes(check.id)) : parsed.spec.tasks.find((entry) => entry.id === taskID);
        if (task === undefined)
            throw new UlwError("TASK_NOT_FOUND", "cannot infer the task for this check; pass taskId");
        if (!task.checks.includes(check.id))
            throw new UlwError("CHECK_SCOPE", `check ${check.id} does not belong to task ${task.id}`);
        const state = run.tasks[task.id];
        if (state === undefined)
            throw new UlwError("TASK_NOT_FOUND", `no task: ${task.id}`);
        if (state.status !== "running" && state.status !== "checking") {
            if (run.status !== "final_verification" || roleBinding?.role !== "verifier") {
                throw new UlwError("TASK_NOT_RUNNING", `task ${task.id} is ${state.status}`);
            }
        }
        await assertPermission(check.id);
        const before = await fingerprintWorkspace(workspace, run.baselineFiles, run.baselineCommit);
        const cwd = resolve(workspace, check.cwd);
        const result = await runProcess({ argv: check.argv, cwd, timeoutMs: check.timeoutMs, signal, maxOutputBytes: this.runtime.options.checkOutputBytes });
        const after = await fingerprintWorkspace(workspace, run.baselineFiles, run.baselineCommit);
        const evaluation = evaluateExpectation(check, result);
        const codeChanged = before.fingerprint !== after.fingerprint;
        const passed = evaluation.passed && !codeChanged;
        const reason = codeChanged ? "product files changed while the check was running" : evaluation.reason;
        const attempt = state.attempts;
        const evidence = await persistCommandEvidence({
            workspace,
            runId: run.id,
            taskId: task.id,
            check,
            attempt,
            codeFingerprint: after.fingerprint,
            result,
            passed,
            reason,
        });
        await store.setEvidence(run.id, evidence.id, evidence);
        if (!passed && run.status === "running" && state.status === "running") {
            await recordTaskFailure(store, run, task.id, `${check.id}: ${reason}`);
        }
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
        return {
            evidence,
            content: `check ${check.id}: ${passed ? "PASS" : "FAIL"} (${reason})\nexit=${String(result.exitCode)} timedOut=${result.timedOut} cancelled=${result.cancelled}\n${output.slice(-4000)}`,
        };
    }
}
//# sourceMappingURL=run-service.js.map
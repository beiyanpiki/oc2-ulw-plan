import { randomUUID } from "node:crypto";
import { UlwError } from "./errors.js";
export function newRunID() {
    return `run-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}
export function createRun(input) {
    const now = Date.now();
    const tasks = {};
    for (const task of input.spec.tasks) {
        tasks[task.id] = { id: task.id, status: "pending", attempts: 0, repeatedFailures: 0, changedFiles: [], updatedAt: now };
    }
    return {
        schema: "ulw-run-record/v1",
        id: newRunID(),
        specId: input.spec.id,
        workspace: input.workspace,
        projectID: input.projectID,
        ownerSessionID: input.ownerSessionID,
        ownerAgent: input.ownerAgent,
        specHash: input.specHash,
        sourceHashes: input.sourceHashes,
        status: "running",
        tasks,
        reviewInvocations: {},
        finalInvocations: {},
        baselineCommit: input.baselineCommit,
        baselineFiles: input.baselineFiles,
        startedAt: now,
        updatedAt: now,
        lockToken: input.lockToken,
        evidenceDir: input.evidenceDir,
    };
}
export async function saveRun(store, run) {
    run.updatedAt = Date.now();
    await store.setRun(run.id, run);
}
export async function loadRun(store, id) {
    const run = await store.getRun(id);
    if (run === undefined || run.schema !== "ulw-run-record/v1")
        throw new UlwError("RUN_NOT_FOUND", `no run: ${id}`);
    return run;
}
export function requireOwner(run, sessionID) {
    if (run.ownerSessionID !== sessionID) {
        throw new UlwError("RUN_OWNER", `run ${run.id} belongs to another session`);
    }
}
export function activeRun(run) {
    return run.status === "running" || run.status === "final_verification";
}
function isTaskSatisfied(run, taskID) {
    const status = run.tasks[taskID]?.status;
    return status === "checked" || status === "passed";
}
export async function claimTask(store, run, spec, taskID, sessionID) {
    requireOwner(run, sessionID);
    if (run.status !== "running")
        throw new UlwError("RUN_NOT_RUNNING", `run is ${run.status}, not running`);
    const task = spec.tasks.find((entry) => entry.id === taskID);
    if (task === undefined)
        throw new UlwError("TASK_NOT_FOUND", `no task: ${taskID}`);
    const state = run.tasks[taskID];
    if (state === undefined)
        throw new UlwError("TASK_NOT_FOUND", `task is absent from run: ${taskID}`);
    if (state.status === "checked" || state.status === "passed") {
        throw new UlwError("TASK_DONE", `task ${taskID} is already ${state.status}`);
    }
    if (state.status === "blocked")
        throw new UlwError("TASK_BLOCKED", `task ${taskID} is blocked; inspect the run`);
    for (const dependency of task.dependsOn) {
        if (!isTaskSatisfied(run, dependency)) {
            throw new UlwError("TASK_DEPENDENCY", `task ${taskID} waits for ${dependency}`);
        }
    }
    if (state.status === "running" || state.status === "checking") {
        return run;
    }
    state.status = "running";
    state.attempts += 1;
    state.startedAt ??= Date.now();
    state.updatedAt = Date.now();
    await saveRun(store, run);
    return run;
}
function commandCheckIDs(spec, taskID) {
    const task = spec.tasks.find((entry) => entry.id === taskID);
    if (task === undefined)
        return [];
    const commandIDs = new Set(spec.checks.filter((check) => check.type === "command").map((check) => check.id));
    return task.checks.filter((id) => commandIDs.has(id));
}
export async function checkpointTask(store, run, spec, taskID, fingerprint, changedFiles, evidence) {
    const task = spec.tasks.find((entry) => entry.id === taskID);
    const state = run.tasks[taskID];
    if (task === undefined || state === undefined)
        throw new UlwError("TASK_NOT_FOUND", `no task: ${taskID}`);
    if (state.status !== "running" && state.status !== "checking" && state.status !== "blocked") {
        throw new UlwError("TASK_STATE", `task ${taskID} is ${state.status}, not running`);
    }
    const required = commandCheckIDs(spec, taskID);
    for (const checkID of required) {
        const passing = evidence.find((entry) => entry.checkId === checkID && entry.taskId === taskID && entry.passed && entry.codeFingerprint === fingerprint);
        if (passing === undefined) {
            throw new UlwError("CHECK_EVIDENCE_MISSING", `task ${taskID} has no passing evidence for ${checkID} at the current code version`);
        }
    }
    if (changedFiles.length === 0) {
        throw new UlwError("TASK_NO_CHANGES", `task ${taskID} has no changed files in its scope`);
    }
    const outside = changedFiles.filter((path) => !task.files.includes(path));
    if (outside.length > 0) {
        throw new UlwError("TASK_CHANGE_SCOPE", `task ${taskID} changed files outside its scope: ${outside.join(", ")}`);
    }
    state.status = "checked";
    state.changedFiles = [...new Set([...state.changedFiles, ...changedFiles])];
    state.checkedAt = Date.now();
    delete state.failureSignature;
    state.repeatedFailures = 0;
    state.fingerprint = fingerprint;
    state.updatedAt = Date.now();
    await saveRun(store, run);
    return run;
}
export async function recordTaskFailure(store, run, taskID, signature, maxAttempts = 3) {
    const state = run.tasks[taskID];
    if (state === undefined)
        throw new UlwError("TASK_NOT_FOUND", `no task: ${taskID}`);
    const normalized = signature.trim().split("\n")[0]?.slice(0, 500) ?? "unknown failure";
    state.repeatedFailures = state.failureSignature === normalized ? state.repeatedFailures + 1 : 1;
    state.failureSignature = normalized;
    state.updatedAt = Date.now();
    const blocked = state.repeatedFailures >= 2 || state.attempts >= maxAttempts;
    if (blocked) {
        state.status = "blocked";
        state.blockedReason = normalized;
    }
    await saveRun(store, run);
    return { blocked, attempts: state.attempts, repeated: state.repeatedFailures };
}
export async function blockTask(store, run, taskID, reason) {
    const state = run.tasks[taskID];
    if (state === undefined)
        throw new UlwError("TASK_NOT_FOUND", `no task: ${taskID}`);
    state.status = "blocked";
    state.blockedReason = reason;
    state.updatedAt = Date.now();
    await saveRun(store, run);
    return run;
}
export async function setRunStatus(store, run, status, reason) {
    run.status = status;
    if (status === "paused")
        run.pauseReason = reason ?? "paused";
    else
        delete run.pauseReason;
    if (status === "blocked" || status === "failed")
        run.failureReason = reason ?? status;
    if (status === "succeeded" || status === "failed")
        run.finishedAt = Date.now();
    await saveRun(store, run);
    return run;
}
export function checkedTaskIDs(run) {
    return Object.values(run.tasks)
        .filter((task) => task.status === "checked" || task.status === "passed")
        .map((task) => task.id);
}
export function allTasksChecked(run) {
    return Object.values(run.tasks).every((task) => task.status === "checked" || task.status === "passed");
}
export function taskScope(spec) {
    return new Set(spec.tasks.flatMap((task) => task.files));
}
export async function completeRun(store, input) {
    const { run, spec } = input;
    if (run.status !== "final_verification")
        throw new UlwError("RUN_NOT_VERIFYING", `run is ${run.status}, not final_verification`);
    if (input.currentSpecHash !== run.specHash)
        throw new UlwError("SPEC_STALE", "spec changed after execution was authorized");
    if (run.verificationFingerprint !== input.currentFingerprint) {
        throw new UlwError("CODE_STALE", "product code changed after final verification started");
    }
    if (!allTasksChecked(run))
        throw new UlwError("TASKS_INCOMPLETE", "not every task is checked");
    const allowed = taskScope(spec);
    const outside = input.changedFiles.filter((path) => !allowed.has(path));
    if (outside.length > 0) {
        throw new UlwError("UNATTRIBUTED_CHANGES", `product changes outside every task scope: ${outside.join(", ")}`);
    }
    for (const invocation of [input.verifierInvocation, input.codeInvocation]) {
        if (invocation.status !== "completed" || invocation.reportId === undefined) {
            throw new UlwError("FINAL_INVOCATION", "a final role did not complete with a bound report");
        }
        if (invocation.targetHash !== run.verificationFingerprint) {
            throw new UlwError("FINAL_TARGET", "a final role reviewed a different code version");
        }
    }
    const verifierPayload = input.verifierReport.payload;
    const codePayload = input.codeReport.payload;
    if (verifierPayload?.verdict !== "approved")
        throw new UlwError("VERIFIER_REJECTED", "independent verifier did not approve");
    if (codePayload?.verdict !== "approved")
        throw new UlwError("CODE_REVIEW_REJECTED", "code review did not approve");
    if (input.verifierReport.targetHash !== run.verificationFingerprint || input.codeReport.targetHash !== run.verificationFingerprint) {
        throw new UlwError("FINAL_REPORT_TARGET", "a final report is bound to another code version");
    }
    for (const task of Object.values(run.tasks)) {
        if (task.status === "checked")
            task.status = "passed";
        task.updatedAt = Date.now();
    }
    run.status = "succeeded";
    run.reportPath = input.reportPath;
    run.finishedAt = Date.now();
    run.updatedAt = Date.now();
    await saveRun(store, run);
    return run;
}
//# sourceMappingURL=run.js.map
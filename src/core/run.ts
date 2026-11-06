import { randomUUID } from "node:crypto";
import { UlwError } from "./errors.js";
import type { BaselineFile, CheckEvidence, RunRecord, Spec, TaskRun } from "./types.js";
import { WorkspaceStore } from "./store.js";

export interface CreateRunInput {
  spec: Spec;
  specHash: string;
  sourceHashes: Record<string, string>;
  workspace: string;
  projectID: string;
  ownerSessionID: string;
  ownerAgent: string;
  baselineCommit: string;
  baselineFiles: Record<string, BaselineFile>;
  lockToken: string;
  evidenceDir: string;
}

export function newRunID(): string {
  return `run-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

export function createRun(input: CreateRunInput): RunRecord {
  const now = Date.now();
  const tasks: Record<string, TaskRun> = {};
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

export async function saveRun(store: WorkspaceStore, run: RunRecord): Promise<void> {
  run.updatedAt = Date.now();
  await store.setRun(run.id, run);
}

export async function loadRun(store: WorkspaceStore, id: string): Promise<RunRecord> {
  const run = await store.getRun<RunRecord>(id);
  if (run === undefined || run.schema !== "ulw-run-record/v1") throw new UlwError("RUN_NOT_FOUND", `no run: ${id}`);
  return run;
}

export function requireOwner(run: RunRecord, sessionID: string): void {
  if (run.ownerSessionID !== sessionID) {
    throw new UlwError("RUN_OWNER", `run ${run.id} belongs to another session`);
  }
}

export function activeRun(run: RunRecord): boolean {
  return run.status === "running" || run.status === "final_verification";
}

function isTaskSatisfied(run: RunRecord, taskID: string): boolean {
  const status = run.tasks[taskID]?.status;
  return status === "checked" || status === "passed";
}

export async function claimTask(
  store: WorkspaceStore,
  run: RunRecord,
  spec: Spec,
  taskID: string,
  sessionID: string,
): Promise<RunRecord> {
  requireOwner(run, sessionID);
  if (run.status !== "running") throw new UlwError("RUN_NOT_RUNNING", `run is ${run.status}, not running`);
  const task = spec.tasks.find((entry) => entry.id === taskID);
  if (task === undefined) throw new UlwError("TASK_NOT_FOUND", `no task: ${taskID}`);
  const state = run.tasks[taskID];
  if (state === undefined) throw new UlwError("TASK_NOT_FOUND", `task is absent from run: ${taskID}`);
  if (state.status === "checked" || state.status === "passed") {
    throw new UlwError("TASK_DONE", `task ${taskID} is already ${state.status}`);
  }
  if (state.status === "blocked") throw new UlwError("TASK_BLOCKED", `task ${taskID} is blocked; inspect the run`);
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

function commandCheckIDs(spec: Spec, taskID: string): string[] {
  const task = spec.tasks.find((entry) => entry.id === taskID);
  if (task === undefined) return [];
  const commandIDs = new Set(spec.checks.filter((check) => check.type === "command").map((check) => check.id));
  return task.checks.filter((id) => commandIDs.has(id));
}

export async function checkpointTask(
  store: WorkspaceStore,
  run: RunRecord,
  spec: Spec,
  taskID: string,
  fingerprint: string,
  changedFiles: string[],
  evidence: CheckEvidence[],
): Promise<RunRecord> {
  const task = spec.tasks.find((entry) => entry.id === taskID);
  const state = run.tasks[taskID];
  if (task === undefined || state === undefined) throw new UlwError("TASK_NOT_FOUND", `no task: ${taskID}`);
  if (state.status !== "running" && state.status !== "checking" && state.status !== "blocked") {
    throw new UlwError("TASK_STATE", `task ${taskID} is ${state.status}, not running`);
  }
  const required = commandCheckIDs(spec, taskID);
  for (const checkID of required) {
    const passing = evidence.find(
      (entry) => entry.checkId === checkID && entry.taskId === taskID && entry.passed && entry.codeFingerprint === fingerprint,
    );
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

export async function recordTaskFailure(
  store: WorkspaceStore,
  run: RunRecord,
  taskID: string,
  signature: string,
  maxAttempts = 3,
): Promise<{ blocked: boolean; attempts: number; repeated: number }> {
  const state = run.tasks[taskID];
  if (state === undefined) throw new UlwError("TASK_NOT_FOUND", `no task: ${taskID}`);
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

export async function blockTask(store: WorkspaceStore, run: RunRecord, taskID: string, reason: string): Promise<RunRecord> {
  const state = run.tasks[taskID];
  if (state === undefined) throw new UlwError("TASK_NOT_FOUND", `no task: ${taskID}`);
  state.status = "blocked";
  state.blockedReason = reason;
  state.updatedAt = Date.now();
  await saveRun(store, run);
  return run;
}

export async function setRunStatus(store: WorkspaceStore, run: RunRecord, status: RunRecord["status"], reason?: string): Promise<RunRecord> {
  run.status = status;
  if (status === "paused") run.pauseReason = reason ?? "paused";
  else delete run.pauseReason;
  if (status === "blocked" || status === "failed") run.failureReason = reason ?? status;
  if (status === "succeeded" || status === "failed") run.finishedAt = Date.now();
  await saveRun(store, run);
  return run;
}

export function checkedTaskIDs(run: RunRecord): string[] {
  return Object.values(run.tasks)
    .filter((task) => task.status === "checked" || task.status === "passed")
    .map((task) => task.id);
}

export function allTasksChecked(run: RunRecord): boolean {
  return Object.values(run.tasks).every((task) => task.status === "checked" || task.status === "passed");
}

export function taskScope(spec: Spec): Set<string> {
  return new Set(spec.tasks.flatMap((task) => task.files));
}

export interface FinalizeInput {
  run: RunRecord;
  spec: Spec;
  currentSpecHash: string;
  currentFingerprint: string;
  changedFiles: string[];
  verifierInvocation: { targetHash: string | undefined; status: string; reportId: string | undefined };
  codeInvocation: { targetHash: string | undefined; status: string; reportId: string | undefined };
  verifierReport: { targetHash?: string; role: "verifier"; payload: unknown };
  codeReport: { targetHash?: string; role: "code-reviewer"; payload: unknown };
  reportPath: string;
}

export async function completeRun(store: WorkspaceStore, input: FinalizeInput): Promise<RunRecord> {
  const { run, spec } = input;
  if (run.status !== "final_verification") throw new UlwError("RUN_NOT_VERIFYING", `run is ${run.status}, not final_verification`);
  if (input.currentSpecHash !== run.specHash) throw new UlwError("SPEC_STALE", "spec changed after execution was authorized");
  if (run.verificationFingerprint !== input.currentFingerprint) {
    throw new UlwError("CODE_STALE", "product code changed after final verification started");
  }
  if (!allTasksChecked(run)) throw new UlwError("TASKS_INCOMPLETE", "not every task is checked");
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
  const verifierPayload = input.verifierReport.payload as { verdict?: string };
  const codePayload = input.codeReport.payload as { verdict?: string };
  if (verifierPayload?.verdict !== "approved") throw new UlwError("VERIFIER_REJECTED", "independent verifier did not approve");
  if (codePayload?.verdict !== "approved") throw new UlwError("CODE_REVIEW_REJECTED", "code review did not approve");
  if (input.verifierReport.targetHash !== run.verificationFingerprint || input.codeReport.targetHash !== run.verificationFingerprint) {
    throw new UlwError("FINAL_REPORT_TARGET", "a final report is bound to another code version");
  }
  for (const task of Object.values(run.tasks)) {
    if (task.status === "checked") task.status = "passed";
    task.updatedAt = Date.now();
  }
  run.status = "succeeded";
  run.reportPath = input.reportPath;
  run.finishedAt = Date.now();
  run.updatedAt = Date.now();
  await saveRun(store, run);
  return run;
}

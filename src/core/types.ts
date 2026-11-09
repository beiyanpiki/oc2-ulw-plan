export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type Risk = "low" | "medium" | "high";

export interface SourceRef {
  path: string;
  sha256?: string;
}

export interface Requirement {
  id: string;
  text: string;
}

export interface Expectation {
  exitCode: number;
  stdoutIncludes: string[];
  stderrIncludes: string[];
}

export interface CommandCheck {
  id: string;
  type: "command";
  description: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  expect: Expectation;
}

export interface ProcedureCheck {
  id: string;
  type: "procedure";
  description: string;
  steps: string[];
  expected: string;
  requiredTools: string[];
}

export type CheckSpec = CommandCheck | ProcedureCheck;

export interface TaskSpec {
  id: string;
  title: string;
  requirements: string[];
  dependsOn: string[];
  files: string[];
  checks: string[];
}

export interface ReviewSpec {
  risk: Risk;
  requireAdversarial: boolean;
}

export interface Spec {
  schema: "ulw-spec/v1";
  id: string;
  title: string;
  sources: SourceRef[];
  requirements: Requirement[];
  nonGoals: string[];
  tasks: TaskSpec[];
  checks: CheckSpec[];
  review: ReviewSpec;
}

export interface Diagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  entity?: string;
}

export interface ParsedSpec {
  spec: Spec;
  body: string;
  sha256: string;
  content: string;
}

export type SpecReviewStatus = "draft" | "validating" | "reviewing" | "ready" | "changes_requested" | "blocked";

export interface SpecReviewRef {
  hash: string;
  round: number;
  verdict: "approved" | "changes_requested" | "blocked" | "inconclusive";
  invocationId: string;
  at: number;
}

export interface SpecRecord {
  schema: "ulw-spec-record/v1";
  id: string;
  workspace: string;
  status: SpecReviewStatus;
  contentHash: string;
  sourceHashes: Record<string, string>;
  requireAdversarial: boolean;
  strict?: boolean;
  risk: Risk;
  practical?: SpecReviewRef;
  adversarial?: SpecReviewRef;
  rounds: number;
  createdAt: number;
  updatedAt: number;
}

export type TaskStatus = "pending" | "running" | "checking" | "checked" | "passed" | "blocked";
export type RunStatus = "preparing" | "running" | "final_verification" | "succeeded" | "paused" | "blocked" | "stale" | "failed";

export interface TaskRun {
  id: string;
  status: TaskStatus;
  attempts: number;
  failureSignature?: string;
  repeatedFailures: number;
  changedFiles: string[];
  blockedReason?: string;
  startedAt?: number;
  checkedAt?: number;
  fingerprint?: string;
  updatedAt: number;
}

export interface BaselineFile {
  path: string;
  sha256: string;
  kind: "file" | "symlink" | "missing";
  dirty: boolean;
  snapshotPath?: string;
}

export interface RunRecord {
  schema: "ulw-run-record/v1";
  id: string;
  specId: string;
  workspace: string;
  projectID: string;
  ownerSessionID: string;
  ownerAgent: string;
  specHash: string;
  sourceHashes: Record<string, string>;
  status: RunStatus;
  tasks: Record<string, TaskRun>;
  reviewInvocations: Record<string, string>;
  finalInvocations: Record<string, string>;
  baselineCommit: string;
  baselineFiles: Record<string, BaselineFile>;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  pauseReason?: string;
  failureReason?: string;
  reportPath?: string;
  verificationFingerprint?: string;
  finalDiffPath?: string;
  lockToken: string;
  evidenceDir: string;
}

export type RoleName =
  | "explorer"
  | "librarian"
  | "consultant"
  | "practical-reviewer"
  | "adversarial-reviewer"
  | "worker"
  | "verifier"
  | "code-reviewer";

export interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

export interface RoleBudgetGrant {
  schema: "ulw-role-budget-grant/v1";
  id: string;
  workspace: string;
  specId: string;
  role: "practical-reviewer" | "adversarial-reviewer";
  parentSessionID: string;
  targetHash: string;
  reason: string;
  createdAt: number;
  consumedBy?: string;
}

export interface RoleInvocation {
  schema: "ulw-role-invocation/v1";
  id: string;
  role: RoleName;
  workspace: string;
  parentSessionID: string;
  childSessionID: string;
  agent: string;
  model?: ModelRef;
  specId?: string;
  runId?: string;
  taskId?: string;
  targetHash?: string;
  budgetKey?: string;
  budgetGrantId?: string;
  status: "running" | "completed" | "failed" | "cancelled" | "timed_out";
  reportId?: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export type InvocationStatus = RoleInvocation["status"];

export interface ActiveRun {
  schema: "ulw-active-run/v1";
  sessionID: string;
  runID: string;
  workspace: string;
  specId: string;
  updatedAt: number;
}

export interface CheckEvidence {
  schema: "ulw-check-evidence/v1";
  id: string;
  runId: string;
  taskId: string;
  checkId: string;
  attempt: number;
  kind: "command" | "procedure";
  codeFingerprint: string;
  argv?: string[];
  cwd?: string;
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  cancelled: boolean;
  passed: boolean;
  outputPath?: string;
  outputTruncated: boolean;
  summary: string;
  startedAt: number;
  finishedAt: number;
}

export interface ReportRecord {
  schema: "ulw-report/v1";
  id: string;
  invocationId: string;
  role: RoleName;
  workspace: string;
  childSessionID: string;
  specId?: string;
  runId?: string;
  taskId?: string;
  targetHash?: string;
  payload: Json;
  createdAt: number;
}

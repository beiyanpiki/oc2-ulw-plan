import { UlwError } from "./errors.js";
import type { ParsedSpec, Risk, RoleInvocation, SpecRecord, SpecReviewRef, SpecReviewStatus } from "./types.js";
import { WorkspaceStore } from "./store.js";
import { effectiveRisk, requiresAdversarial } from "./spec.js";
import { isApprovedPlanReport } from "./reports.js";
import type { ReportRecord } from "./types.js";

export function createSpecRecord(
  parsed: ParsedSpec,
  workspace: string,
  sourceHashes: Record<string, string>,
  requireAdversarial: boolean,
): SpecRecord {
  const now = Date.now();
  return {
    schema: "ulw-spec-record/v1",
    id: parsed.spec.id,
    workspace,
    status: "draft",
    contentHash: parsed.sha256,
    sourceHashes,
    requireAdversarial,
    risk: effectiveRisk(parsed.spec, parsed.body),
    rounds: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export async function loadSpecRecord(store: WorkspaceStore, id: string): Promise<SpecRecord> {
  const record = await store.getSpec<SpecRecord>(id);
  if (record === undefined || record.schema !== "ulw-spec-record/v1") {
    throw new UlwError("SPEC_NOT_FOUND", `no spec record: ${id}`);
  }
  return record;
}

export async function saveSpecRecord(store: WorkspaceStore, record: SpecRecord): Promise<void> {
  record.updatedAt = Date.now();
  await store.setSpec(record.id, record);
}

export function reviewRequired(record: SpecRecord): boolean {
  return record.requireAdversarial || record.risk === "high";
}

export function setStatus(record: SpecRecord, status: SpecReviewStatus): void {
  record.status = status;
  record.updatedAt = Date.now();
}

export function recordPlanReview(record: SpecRecord, report: ReportRecord, invocationId: string, role: "practical" | "adversarial"): void {
  if (report.targetHash !== record.contentHash) {
    throw new UlwError("REVIEW_STALE", "review report is for a different spec version");
  }
  const payload = report.payload as { verdict?: string; escalate?: boolean };
  if (payload.verdict === undefined) throw new UlwError("REVIEW_VERDICT", "review report has no verdict");
  const ref: SpecReviewRef = {
    hash: record.contentHash,
    round: record.rounds + 1,
    verdict: payload.verdict as SpecReviewRef["verdict"],
    invocationId,
    at: Date.now(),
  };
  if (role === "practical") {
    record.practical = ref;
    delete record.adversarial;
    if (payload.escalate === true) record.requireAdversarial = true;
  } else {
    record.adversarial = ref;
  }
  if (payload.verdict === "approved") {
    record.status = "reviewing";
  } else if (payload.verdict === "changes_requested") {
    record.status = "changes_requested";
  } else if (payload.verdict === "blocked") {
    record.status = "blocked";
  } else {
    record.status = "reviewing";
  }
  record.rounds += 1;
  record.updatedAt = Date.now();
}

export interface PublishCheck {
  ok: boolean;
  missing: string[];
}

export function publishCheck(record: SpecRecord, parsed: ParsedSpec, requireAdversarial: boolean): PublishCheck {
  const missing: string[] = [];
  if (record.contentHash !== parsed.sha256) missing.push("spec file changed since validation");
  if (record.practical === undefined || record.practical.hash !== parsed.sha256 || record.practical.verdict !== "approved") {
    missing.push("practical reviewer approval for the current spec");
  }
  const needAdversarial = requireRequiredAdversarial(record, parsed, requireAdversarial);
  if (needAdversarial && (record.adversarial === undefined || record.adversarial.hash !== parsed.sha256 || record.adversarial.verdict !== "approved")) {
    missing.push("adversarial reviewer approval for the current spec");
  }
  return { ok: missing.length === 0, missing };
}

export function requireRequiredAdversarial(record: SpecRecord, parsed: ParsedSpec, strict: boolean): boolean {
  return (
    strict ||
    reviewRequired(record) ||
    requiresAdversarial(parsed.spec, parsed.body, strict) ||
    (record.practical !== undefined && record.practical.verdict === "approved" && record.adversarial === undefined && record.risk === "high")
  );
}

export function publishRecord(record: SpecRecord, parsed: ParsedSpec, requireAdversarial: boolean): void {
  const check = publishCheck(record, parsed, requireAdversarial);
  if (!check.ok) throw new UlwError("SPEC_NOT_APPROVED", `spec cannot be published: ${check.missing.join("; ")}`);
  record.status = "ready";
  record.risk = effectiveRisk(parsed.spec, parsed.body) as Risk;
  record.requireAdversarial = requireRequiredAdversarial(record, parsed, requireAdversarial);
  record.updatedAt = Date.now();
}

export function hasApprovedPlanReport(record: SpecRecord, report: ReportRecord | undefined, role: "practical" | "adversarial"): boolean {
  const ref = role === "practical" ? record.practical : record.adversarial;
  return report !== undefined && ref !== undefined && ref.invocationId === report.invocationId && isApprovedPlanReport(report);
}

export async function verifyPlanReview(store: WorkspaceStore, record: SpecRecord, role: "practical" | "adversarial"): Promise<{ ok: boolean; reason: string }> {
  const ref = role === "practical" ? record.practical : record.adversarial;
  if (ref === undefined) return { ok: false, reason: `missing ${role} review` };
  if (ref.hash !== record.contentHash) return { ok: false, reason: `${role} review is stale` };
  if (ref.verdict !== "approved") return { ok: false, reason: `${role} review is ${ref.verdict}` };
  const invocation = await store.getInvocation<RoleInvocation>(ref.invocationId);
  if (invocation === undefined) return { ok: false, reason: `${role} invocation is missing` };
  const expectedRole = role === "practical" ? "practical-reviewer" : "adversarial-reviewer";
  if (invocation.role !== expectedRole || invocation.status !== "completed" || invocation.reportId === undefined) {
    return { ok: false, reason: `${role} invocation did not complete with a report` };
  }
  const report = await store.getReport<ReportRecord>(invocation.reportId);
  if (report === undefined || report.targetHash !== record.contentHash || !isApprovedPlanReport(report)) {
    return { ok: false, reason: `${role} report is not a bound approval` };
  }
  return { ok: true, reason: "approved" };
}

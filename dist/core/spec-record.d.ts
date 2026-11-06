import type { ParsedSpec, SpecRecord, SpecReviewStatus } from "./types.js";
import { WorkspaceStore } from "./store.js";
import type { ReportRecord } from "./types.js";
export declare function createSpecRecord(parsed: ParsedSpec, workspace: string, sourceHashes: Record<string, string>, requireAdversarial: boolean): SpecRecord;
export declare function loadSpecRecord(store: WorkspaceStore, id: string): Promise<SpecRecord>;
export declare function saveSpecRecord(store: WorkspaceStore, record: SpecRecord): Promise<void>;
export declare function reviewRequired(record: SpecRecord): boolean;
export declare function setStatus(record: SpecRecord, status: SpecReviewStatus): void;
export declare function recordPlanReview(record: SpecRecord, report: ReportRecord, invocationId: string, role: "practical" | "adversarial"): void;
export interface PublishCheck {
    ok: boolean;
    missing: string[];
}
export declare function publishCheck(record: SpecRecord, parsed: ParsedSpec, requireAdversarial: boolean): PublishCheck;
export declare function requireRequiredAdversarial(record: SpecRecord, parsed: ParsedSpec, strict: boolean): boolean;
export declare function publishRecord(record: SpecRecord, parsed: ParsedSpec, requireAdversarial: boolean): void;
export declare function hasApprovedPlanReport(record: SpecRecord, report: ReportRecord | undefined, role: "practical" | "adversarial"): boolean;
export declare function verifyPlanReview(store: WorkspaceStore, record: SpecRecord, role: "practical" | "adversarial"): Promise<{
    ok: boolean;
    reason: string;
}>;

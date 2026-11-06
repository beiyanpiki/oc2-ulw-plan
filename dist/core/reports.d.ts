import type { CheckSpec, Json, ReportRecord, RoleName, Spec, TaskSpec } from "./types.js";
export declare function validateRoleReport(role: RoleName, payload: Json, context: {
    task?: TaskSpec;
    spec?: Spec;
}): void;
export declare function reportVerdict(report: ReportRecord): string | undefined;
export declare function isApprovedPlanReport(report: ReportRecord): boolean;
export declare function isApprovedVerifierReport(report: ReportRecord): boolean;
export declare function isApprovedCodeReport(report: ReportRecord): boolean;
export declare function procedureChecks(spec: Spec): CheckSpec[];

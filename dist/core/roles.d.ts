import type { RoleInvocation, RoleName } from "./types.js";
export interface RolePolicy {
    role: RoleName;
    profile: string;
    scope: "plan" | "run" | "both";
    maxPerTarget: number;
    independent: boolean;
    readOnly: boolean;
}
export declare const ROLE_POLICIES: Record<RoleName, RolePolicy>;
export declare function policyFor(role: RoleName): RolePolicy;
export declare function roleInvocations(invocations: Array<{
    id: string;
    value: RoleInvocation;
}>, role: RoleName, target: RoleBudgetTarget): RoleInvocation[];
export interface RoleBudgetTarget {
    workspace?: string;
    specId?: string;
    runId?: string;
    taskId?: string;
    targetHash?: string;
}
export declare function roleBudget(invocations: Array<{
    id: string;
    value: RoleInvocation;
}>, role: RoleName, target: RoleBudgetTarget, max?: number): {
    attempts: number;
    reports: number;
    grantsUsed: number;
    maxReports: number;
    maxAttempts: number;
};
export declare function assertBudget(invocations: Array<{
    id: string;
    value: RoleInvocation;
}>, role: RoleName, target: RoleBudgetTarget, max?: number): void;
export declare function planRoles(): RoleName[];
export declare function finalRoles(): RoleName[];
export declare function isFinalRole(role: RoleName): boolean;
export declare function isPlanRole(role: RoleName): boolean;

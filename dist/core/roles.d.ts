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
}>, role: RoleName, target: {
    specId?: string;
    runId?: string;
    taskId?: string;
    targetHash?: string;
}): RoleInvocation[];
export declare function assertBudget(invocations: Array<{
    id: string;
    value: RoleInvocation;
}>, role: RoleName, target: {
    specId?: string;
    runId?: string;
    taskId?: string;
    targetHash?: string;
}, max?: number): void;
export declare function planRoles(): RoleName[];
export declare function finalRoles(): RoleName[];
export declare function isFinalRole(role: RoleName): boolean;
export declare function isPlanRole(role: RoleName): boolean;

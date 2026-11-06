import { UlwError } from "./errors.js";
import type { RoleInvocation, RoleName } from "./types.js";

export interface RolePolicy {
  role: RoleName;
  profile: string;
  scope: "plan" | "run" | "both";
  maxPerTarget: number;
  independent: boolean;
  readOnly: boolean;
}

export const ROLE_POLICIES: Record<RoleName, RolePolicy> = {
  explorer: { role: "explorer", profile: "ulw-readonly", scope: "plan", maxPerTarget: 2, independent: false, readOnly: true },
  librarian: { role: "librarian", profile: "ulw-readonly", scope: "plan", maxPerTarget: 2, independent: false, readOnly: true },
  consultant: { role: "consultant", profile: "ulw-readonly", scope: "plan", maxPerTarget: 1, independent: false, readOnly: true },
  "practical-reviewer": { role: "practical-reviewer", profile: "ulw-readonly", scope: "plan", maxPerTarget: 2, independent: true, readOnly: true },
  "adversarial-reviewer": { role: "adversarial-reviewer", profile: "ulw-readonly", scope: "plan", maxPerTarget: 2, independent: true, readOnly: true },
  worker: { role: "worker", profile: "ulw-worker", scope: "run", maxPerTarget: 3, independent: false, readOnly: false },
  verifier: { role: "verifier", profile: "ulw-verifier", scope: "run", maxPerTarget: 2, independent: true, readOnly: true },
  "code-reviewer": { role: "code-reviewer", profile: "ulw-readonly", scope: "run", maxPerTarget: 2, independent: true, readOnly: true },
};

export function policyFor(role: RoleName): RolePolicy {
  const policy = ROLE_POLICIES[role];
  if (policy === undefined) throw new UlwError("ROLE_UNKNOWN", `unknown role: ${role}`);
  return policy;
}

export function roleInvocations(
  invocations: Array<{ id: string; value: RoleInvocation }>,
  role: RoleName,
  target: { specId?: string; runId?: string; taskId?: string; targetHash?: string },
): RoleInvocation[] {
  return invocations
    .map((entry) => entry.value)
    .filter((invocation) => {
      if (invocation.role !== role) return false;
      if (target.specId !== undefined && invocation.specId !== target.specId) return false;
      if (target.runId !== undefined && invocation.runId !== target.runId) return false;
      if (target.taskId !== undefined && invocation.taskId !== target.taskId) return false;
      if (target.targetHash !== undefined && invocation.targetHash !== target.targetHash) return false;
      return true;
    })
    .sort((left, right) => left.createdAt - right.createdAt);
}

export function assertBudget(
  invocations: Array<{ id: string; value: RoleInvocation }>,
  role: RoleName,
  target: { specId?: string; runId?: string; taskId?: string; targetHash?: string },
  max = policyFor(role).maxPerTarget,
): void {
  const existing = roleInvocations(invocations, role, target);
  const running = existing.filter((invocation) => invocation.status === "running");
  if (running.length > 0) {
    throw new UlwError("ROLE_IN_FLIGHT", `${role} already has an invocation for this target: ${running[0]?.id ?? ""}`);
  }
  if (existing.length >= max) {
    throw new UlwError("ROLE_BUDGET", `${role} budget exhausted (${existing.length}/${max}) for this target`);
  }
}

export function planRoles(): RoleName[] {
  return ["explorer", "librarian", "consultant", "practical-reviewer", "adversarial-reviewer"];
}

export function finalRoles(): RoleName[] {
  return ["verifier", "code-reviewer"];
}

export function isFinalRole(role: RoleName): boolean {
  return role === "verifier" || role === "code-reviewer";
}

export function isPlanRole(role: RoleName): boolean {
  return role === "practical-reviewer" || role === "adversarial-reviewer";
}

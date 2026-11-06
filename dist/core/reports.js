import { UlwError } from "./errors.js";
function record(value, label) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new UlwError("REPORT_SHAPE", `${label} must be an object`);
    }
    return value;
}
function stringValue(value, label) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new UlwError("REPORT_SHAPE", `${label} must be a non-empty string`);
    }
    return value.trim();
}
function stringArray(value, label) {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        throw new UlwError("REPORT_SHAPE", `${label} must be a string array`);
    }
    return value.map((entry) => String(entry).trim()).filter(Boolean);
}
function verdictOf(value) {
    if (value === "approved" || value === "changes_requested" || value === "blocked" || value === "inconclusive")
        return value;
    throw new UlwError("REPORT_VERDICT", "verdict must be approved, changes_requested, blocked or inconclusive");
}
function parseFindings(value) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value))
        throw new UlwError("REPORT_SHAPE", "findings must be an array");
    return value.map((entry, index) => {
        const finding = record(entry, `findings[${index}]`);
        return {
            description: stringValue(finding.description, `findings[${index}].description`),
            evidence: stringArray(finding.evidence, `findings[${index}].evidence`),
            category: typeof finding.category === "string" ? finding.category : "other",
        };
    });
}
export function validateRoleReport(role, payload, context) {
    const root = record(payload, "payload");
    if (role === "worker") {
        const taskId = stringValue(root.taskId, "payload.taskId");
        if (context.task !== undefined && taskId !== context.task.id) {
            throw new UlwError("REPORT_TASK_MISMATCH", `worker report is for ${taskId}, expected ${context.task.id}`);
        }
        const status = stringValue(root.status, "payload.status");
        if (status !== "completed" && status !== "blocked")
            throw new UlwError("REPORT_STATUS", "worker status must be completed or blocked");
        const changed = stringArray(root.changedFiles, "payload.changedFiles");
        if (status === "completed" && changed.length === 0) {
            throw new UlwError("REPORT_CHANGES", "completed worker report must list changed files");
        }
        if (context.task !== undefined) {
            for (const path of changed) {
                if (!context.task.files.includes(path)) {
                    throw new UlwError("REPORT_SCOPE", `worker changed a file outside task scope: ${path}`);
                }
            }
        }
        stringValue(root.summary, "payload.summary");
        stringArray(root.knownIssues ?? [], "payload.knownIssues");
        return;
    }
    if (role === "practical-reviewer" || role === "adversarial-reviewer") {
        const verdict = verdictOf(root.verdict);
        const blockers = parseFindings(root.blockers);
        stringArray(root.notes ?? [], "payload.notes");
        if (root.escalate !== undefined && typeof root.escalate !== "boolean") {
            throw new UlwError("REPORT_SHAPE", "payload.escalate must be boolean");
        }
        if (verdict === "approved" && blockers.length > 0) {
            throw new UlwError("REPORT_CONTRADICTION", "approved review cannot carry blockers");
        }
        for (const blocker of blockers) {
            if (blocker.evidence.length === 0)
                throw new UlwError("REPORT_EVIDENCE", "each blocker needs concrete evidence");
        }
        return;
    }
    if (role === "verifier") {
        const verdict = verdictOf(root.verdict);
        const requirements = Array.isArray(root.requirements) ? root.requirements : [];
        const procedures = Array.isArray(root.procedures) ? root.procedures : [];
        if (requirements.length === 0)
            throw new UlwError("REPORT_COVERAGE", "verifier must report requirement coverage");
        if (context.spec !== undefined) {
            for (const requirement of context.spec.requirements) {
                if (!requirements.some((entry) => record(entry, "requirement").id === requirement.id)) {
                    throw new UlwError("REPORT_COVERAGE", `verifier did not report requirement ${requirement.id}`);
                }
            }
            const procedureChecks = context.spec.checks.filter((check) => check.type === "procedure");
            for (const check of procedureChecks) {
                const covered = procedures.some((entry) => record(entry, "procedure").checkId === check.id);
                if (!covered)
                    throw new UlwError("REPORT_COVERAGE", `verifier did not report procedure ${check.id}`);
            }
        }
        if (verdict === "approved") {
            for (const entry of requirements) {
                const item = record(entry, "requirement");
                stringValue(item.id, "requirements[].id");
                if (item.status !== "satisfied")
                    throw new UlwError("REPORT_CONTRADICTION", "approved verifier report has an unsatisfied requirement");
                if (stringArray(item.evidence, "requirements[].evidence").length === 0) {
                    throw new UlwError("REPORT_EVIDENCE", "satisfied requirements need evidence");
                }
            }
            for (const entry of procedures) {
                const item = record(entry, "procedure");
                stringValue(item.checkId, "procedures[].checkId");
                if (item.status !== "passed")
                    throw new UlwError("REPORT_CONTRADICTION", "approved verifier report has a failed procedure");
                if (stringArray(item.evidence, "procedures[].evidence").length === 0) {
                    throw new UlwError("REPORT_EVIDENCE", "passed procedures need evidence");
                }
            }
        }
        return;
    }
    if (role === "code-reviewer") {
        const verdict = verdictOf(root.verdict);
        if (!Array.isArray(root.findings))
            throw new UlwError("REPORT_SHAPE", "payload.findings must be an array");
        const findings = root.findings.map((entry, index) => {
            const finding = record(entry, `findings[${index}]`);
            const severity = stringValue(finding.severity, `findings[${index}].severity`);
            if (!["blocker", "major", "minor", "note"].includes(severity)) {
                throw new UlwError("REPORT_SEVERITY", "finding severity must be blocker, major, minor or note");
            }
            return { severity, description: stringValue(finding.description, `findings[${index}].description`) };
        });
        if (verdict === "approved" && findings.some((finding) => finding.severity === "blocker" || finding.severity === "major")) {
            throw new UlwError("REPORT_CONTRADICTION", "approved code review cannot carry blocker or major findings");
        }
        return;
    }
    if (role === "explorer" || role === "librarian" || role === "consultant") {
        stringValue(root.summary, "payload.summary");
        if (root.findings !== undefined) {
            parseFindings(root.findings);
        }
        stringArray(root.openQuestions ?? [], "payload.openQuestions");
        return;
    }
    throw new UlwError("REPORT_ROLE", `unsupported report role: ${role}`);
}
export function reportVerdict(report) {
    const payload = record(report.payload, "payload");
    return typeof payload.verdict === "string" ? payload.verdict : undefined;
}
export function isApprovedPlanReport(report) {
    const payload = record(report.payload, "payload");
    return payload.verdict === "approved" && Array.isArray(payload.blockers) && payload.blockers.length === 0;
}
export function isApprovedVerifierReport(report) {
    return reportVerdict(report) === "approved";
}
export function isApprovedCodeReport(report) {
    return reportVerdict(report) === "approved";
}
export function procedureChecks(spec) {
    return spec.checks.filter((check) => check.type === "procedure");
}
//# sourceMappingURL=reports.js.map
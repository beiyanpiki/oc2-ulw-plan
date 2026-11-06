import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import { UlwError } from "./errors.js";
export const SPEC_SCHEMA = "ulw-spec/v1";
export const SPEC_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const DEFAULT_CHECK_TIMEOUT_MS = 120_000;
export const MAX_CHECK_TIMEOUT_MS = 900_000;
export const MAX_SPEC_BYTES = 1024 * 1024;
const TOP_KEYS = new Set(["schema", "id", "title", "sources", "requirements", "nonGoals", "tasks", "checks", "review"]);
const SOURCE_KEYS = new Set(["path", "sha256"]);
const REQUIREMENT_KEYS = new Set(["id", "text"]);
const TASK_KEYS = new Set(["id", "title", "requirements", "dependsOn", "files", "checks"]);
const REVIEW_KEYS = new Set(["risk", "requireAdversarial"]);
const COMMAND_CHECK_KEYS = new Set(["id", "type", "description", "argv", "cwd", "timeoutMs", "expect"]);
const PROCEDURE_CHECK_KEYS = new Set(["id", "type", "description", "steps", "expected", "requiredTools"]);
const EXPECT_KEYS = new Set(["exitCode", "stdoutIncludes", "stderrIncludes"]);
const PLACEHOLDER_RE = /<fill\b|\bTODO\b|\bTBD\b|placeholder|待补充|待填写/i;
export function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
export function isSpecSlug(value) {
    return value.length >= 1 && value.length <= 80 && SPEC_SLUG_RE.test(value);
}
export function assertSafeRelativePath(value, label) {
    const normalized = value.replaceAll("\\", "/").trim();
    if (normalized === "")
        throw new UlwError("PATH_EMPTY", `${label}: path is empty`);
    if (normalized.includes("\0"))
        throw new UlwError("PATH_NUL", `${label}: NUL is not allowed`);
    if (isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
        throw new UlwError("PATH_ABSOLUTE", `${label}: absolute paths are not allowed: ${value}`);
    }
    const parts = normalized.split("/");
    if (parts.includes(".."))
        throw new UlwError("PATH_TRAVERSAL", `${label}: parent traversal is not allowed: ${value}`);
    if (parts.includes(".git"))
        throw new UlwError("PATH_GIT", `${label}: .git paths are not allowed`);
    if (parts[0] === ".opencode" && parts[1] === "ulw") {
        throw new UlwError("PATH_ARTIFACT", `${label}: the ulw artifact root is not a product path`);
    }
    if (parts.some((part) => part === ".env" || part.startsWith(".env."))) {
        throw new UlwError("PATH_SECRET", `${label}: environment files cannot be task targets`);
    }
    return parts.filter((part) => part !== "." && part !== "").join("/") || ".";
}
export function isWithin(parent, child) {
    const rel = relative(resolve(parent), resolve(child));
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
export function parseFrontmatter(content) {
    const normalized = content.startsWith("\uFEFF") ? content.slice(1) : content;
    if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) {
        throw new UlwError("SPEC_FRONTMATTER", "spec must start with a YAML frontmatter block");
    }
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(normalized);
    if (match === null)
        throw new UlwError("SPEC_FRONTMATTER", "spec frontmatter is not closed with ---");
    const body = normalized.slice(match[0].length);
    if (body.trim() === "")
        throw new UlwError("SPEC_BODY", "spec body must explain the design and decisions");
    return { yaml: match[1] ?? "", body };
}
function expectRecord(value, label) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new UlwError("SPEC_SHAPE", `${label} must be a mapping`);
    }
    return value;
}
function expectArray(value, label) {
    if (!Array.isArray(value))
        throw new UlwError("SPEC_SHAPE", `${label} must be an array`);
    return value;
}
function expectString(value, label, nonEmpty = true) {
    if (typeof value !== "string")
        throw new UlwError("SPEC_SHAPE", `${label} must be a string`);
    const text = value.trim();
    if (nonEmpty && text === "")
        throw new UlwError("SPEC_SHAPE", `${label} must not be empty`);
    return text;
}
function expectStringArray(value, label) {
    return expectArray(value, label).map((entry, index) => expectString(entry, `${label}[${index}]`));
}
function expectKeys(value, allowed, label) {
    for (const key of Object.keys(value)) {
        if (!allowed.has(key))
            throw new UlwError("SPEC_UNKNOWN_KEY", `${label}: unknown key ${JSON.stringify(key)}`);
    }
}
function parseSources(value) {
    return expectArray(value, "sources").map((entry, index) => {
        const source = expectRecord(entry, `sources[${index}]`);
        expectKeys(source, SOURCE_KEYS, `sources[${index}]`);
        const path = assertSafeRelativePath(expectString(source.path, `sources[${index}].path`), `sources[${index}].path`);
        const sha = source.sha256 === undefined ? undefined : expectString(source.sha256, `sources[${index}].sha256`);
        if (sha !== undefined && !/^[a-f0-9]{64}$/.test(sha)) {
            throw new UlwError("SPEC_SOURCE_HASH", `sources[${index}].sha256 must be a lowercase sha256`);
        }
        return sha === undefined ? { path } : { path, sha256: sha };
    });
}
function parseRequirements(value) {
    return expectArray(value, "requirements").map((entry, index) => {
        const requirement = expectRecord(entry, `requirements[${index}]`);
        expectKeys(requirement, REQUIREMENT_KEYS, `requirements[${index}]`);
        const id = expectString(requirement.id, `requirements[${index}].id`);
        if (!/^R[1-9]\d*$/.test(id))
            throw new UlwError("SPEC_ID", `requirement id must look like R1: ${id}`);
        return { id, text: expectString(requirement.text, `requirements[${index}].text`) };
    });
}
function parseTasks(value) {
    return expectArray(value, "tasks").map((entry, index) => {
        const task = expectRecord(entry, `tasks[${index}]`);
        expectKeys(task, TASK_KEYS, `tasks[${index}]`);
        const id = expectString(task.id, `tasks[${index}].id`);
        if (!/^T[1-9]\d*$/.test(id))
            throw new UlwError("SPEC_ID", `task id must look like T1: ${id}`);
        const files = expectStringArray(task.files, `tasks[${index}].files`).map((path, fileIndex) => assertSafeRelativePath(path, `tasks[${index}].files[${fileIndex}]`));
        const requirements = expectStringArray(task.requirements, `tasks[${index}].requirements`);
        const dependsOn = task.dependsOn === undefined ? [] : expectStringArray(task.dependsOn, `tasks[${index}].dependsOn`);
        const checks = expectStringArray(task.checks, `tasks[${index}].checks`);
        return {
            id,
            title: expectString(task.title, `tasks[${index}].title`),
            requirements,
            dependsOn,
            files,
            checks,
        };
    });
}
function parseExpectation(value, label) {
    if (value === undefined)
        return { exitCode: 0, stdoutIncludes: [], stderrIncludes: [] };
    const expect = expectRecord(value, label);
    expectKeys(expect, EXPECT_KEYS, label);
    const exitCode = expect.exitCode === undefined ? 0 : Number(expect.exitCode);
    if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
        throw new UlwError("SPEC_CHECK", `${label}.exitCode must be an integer between 0 and 255`);
    }
    return {
        exitCode,
        stdoutIncludes: expect.stdoutIncludes === undefined ? [] : expectStringArray(expect.stdoutIncludes, `${label}.stdoutIncludes`),
        stderrIncludes: expect.stderrIncludes === undefined ? [] : expectStringArray(expect.stderrIncludes, `${label}.stderrIncludes`),
    };
}
function parseChecks(value) {
    return expectArray(value, "checks").map((entry, index) => {
        const check = expectRecord(entry, `checks[${index}]`);
        const id = expectString(check.id, `checks[${index}].id`);
        if (!/^V[1-9]\d*$/.test(id))
            throw new UlwError("SPEC_ID", `check id must look like V1: ${id}`);
        const type = expectString(check.type, `checks[${index}].type`);
        if (type === "command") {
            expectKeys(check, COMMAND_CHECK_KEYS, `checks[${index}]`);
            const argv = expectStringArray(check.argv, `checks[${index}].argv`);
            if (argv.length === 0)
                throw new UlwError("SPEC_CHECK", `checks[${index}].argv must not be empty`);
            const cwd = check.cwd === undefined ? "." : assertSafeRelativePath(expectString(check.cwd, `checks[${index}].cwd`), `checks[${index}].cwd`);
            const timeoutMs = check.timeoutMs === undefined ? DEFAULT_CHECK_TIMEOUT_MS : Number(check.timeoutMs);
            if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_CHECK_TIMEOUT_MS) {
                throw new UlwError("SPEC_CHECK", `checks[${index}].timeoutMs must be 1..${MAX_CHECK_TIMEOUT_MS}`);
            }
            return {
                id,
                type: "command",
                description: check.description === undefined ? `Command check ${id}` : expectString(check.description, `checks[${index}].description`),
                argv,
                cwd,
                timeoutMs,
                expect: parseExpectation(check.expect, `checks[${index}].expect`),
            };
        }
        if (type === "procedure") {
            expectKeys(check, PROCEDURE_CHECK_KEYS, `checks[${index}]`);
            return {
                id,
                type: "procedure",
                description: check.description === undefined ? `Procedure check ${id}` : expectString(check.description, `checks[${index}].description`),
                steps: expectStringArray(check.steps, `checks[${index}].steps`),
                expected: expectString(check.expected, `checks[${index}].expected`),
                requiredTools: check.requiredTools === undefined ? [] : expectStringArray(check.requiredTools, `checks[${index}].requiredTools`),
            };
        }
        throw new UlwError("SPEC_CHECK", `checks[${index}].type must be command or procedure`);
    });
}
function parseReview(value) {
    if (value === undefined)
        return { risk: "low", requireAdversarial: false };
    const review = expectRecord(value, "review");
    expectKeys(review, REVIEW_KEYS, "review");
    const risk = (review.risk === undefined ? "low" : expectString(review.risk, "review.risk"));
    if (!["low", "medium", "high"].includes(risk))
        throw new UlwError("SPEC_REVIEW", "review.risk must be low, medium, or high");
    const requireAdversarial = review.requireAdversarial === undefined ? false : review.requireAdversarial;
    if (typeof requireAdversarial !== "boolean")
        throw new UlwError("SPEC_REVIEW", "review.requireAdversarial must be boolean");
    return { risk, requireAdversarial };
}
export function parseSpec(content) {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_SPEC_BYTES)
        throw new UlwError("SPEC_TOO_LARGE", `spec exceeds ${MAX_SPEC_BYTES} bytes`);
    const { yaml, body } = parseFrontmatter(content);
    const document = parseDocument(yaml, { uniqueKeys: true, prettyErrors: true });
    if (document.errors.length > 0) {
        throw new UlwError("SPEC_YAML", document.errors.map((error) => error.message).join("; "));
    }
    const raw = document.toJS({ maxAliasCount: 0 });
    const root = expectRecord(raw, "spec");
    expectKeys(root, TOP_KEYS, "spec");
    for (const key of ["schema", "id", "title", "requirements", "tasks", "checks"]) {
        if (root[key] === undefined)
            throw new UlwError("SPEC_MISSING", `spec.${key} is required`);
    }
    const schema = expectString(root.schema, "spec.schema");
    if (schema !== SPEC_SCHEMA)
        throw new UlwError("SPEC_SCHEMA", `unsupported spec schema: ${schema}`);
    const id = expectString(root.id, "spec.id");
    if (!isSpecSlug(id))
        throw new UlwError("SPEC_ID", "spec.id must be a lowercase kebab-case slug up to 80 characters");
    const nonGoals = root.nonGoals === undefined ? [] : expectStringArray(root.nonGoals, "spec.nonGoals");
    const spec = {
        schema: SPEC_SCHEMA,
        id,
        title: expectString(root.title, "spec.title"),
        sources: root.sources === undefined ? [] : parseSources(root.sources),
        requirements: parseRequirements(root.requirements),
        nonGoals,
        tasks: parseTasks(root.tasks),
        checks: parseChecks(root.checks),
        review: parseReview(root.review),
    };
    return { spec, body, sha256: sha256(content), content };
}
export function hasPlaceholder(value) {
    return PLACEHOLDER_RE.test(value);
}
export function inferRisk(spec, body) {
    const text = [body, ...spec.tasks.flatMap((task) => [task.title, ...task.files]), ...spec.requirements.map((entry) => entry.text)].join("\n");
    if (/(^|[/\\._-])(auth|security|secret|password|oauth|token|session|permission|migration|migrations)([/\\._-]|$)/i.test(text))
        return "high";
    if (/\b(drop table|delete data|irreversible|destructive|concurren|transaction boundary|data migration)\b/i.test(text))
        return "high";
    return spec.review.risk;
}
export function effectiveRisk(spec, body) {
    const inferred = inferRisk(spec, body);
    if (spec.review.risk === "high" || inferred === "high")
        return "high";
    if (spec.review.risk === "medium" || inferred === "medium")
        return "medium";
    return "low";
}
export function requiresAdversarial(spec, body, strict) {
    return strict || spec.review.requireAdversarial || effectiveRisk(spec, body) === "high";
}
export function lintSpec(parsed, strict) {
    const { spec, body } = parsed;
    const diagnostics = [];
    const error = (code, message, entity) => {
        diagnostics.push(entity === undefined ? { severity: "error", code, message } : { severity: "error", code, message, entity });
    };
    const warning = (code, message, entity) => {
        diagnostics.push(entity === undefined ? { severity: "warning", code, message } : { severity: "warning", code, message, entity });
    };
    if (spec.requirements.length === 0)
        error("REQUIREMENTS_EMPTY", "at least one requirement is required");
    if (spec.tasks.length === 0)
        error("TASKS_EMPTY", "at least one task is required");
    if (spec.checks.length === 0)
        error("CHECKS_EMPTY", "at least one check is required");
    const requirementIDs = new Set();
    for (const requirement of spec.requirements) {
        if (requirementIDs.has(requirement.id))
            error("REQUIREMENT_DUPLICATE", `duplicate requirement ${requirement.id}`, requirement.id);
        requirementIDs.add(requirement.id);
        if (hasPlaceholder(requirement.text))
            error("PLACEHOLDER", `requirement ${requirement.id} contains a placeholder`, requirement.id);
    }
    const taskIDs = new Set();
    const checkIDs = new Set();
    for (const check of spec.checks) {
        if (checkIDs.has(check.id))
            error("CHECK_DUPLICATE", `duplicate check ${check.id}`, check.id);
        checkIDs.add(check.id);
        if (hasPlaceholder(check.description))
            error("PLACEHOLDER", `check ${check.id} description contains a placeholder`, check.id);
        if (check.type === "procedure") {
            if (check.steps.length === 0)
                error("CHECK_STEPS_EMPTY", `procedure check ${check.id} needs steps`, check.id);
            if (check.expected.trim() === "")
                error("CHECK_EXPECTED_EMPTY", `procedure check ${check.id} needs an expected observation`, check.id);
            for (const step of check.steps) {
                if (hasPlaceholder(step))
                    error("PLACEHOLDER", `procedure check ${check.id} step contains a placeholder`, check.id);
            }
        }
    }
    const referencedChecks = new Set();
    const coveredRequirements = new Set();
    for (const task of spec.tasks) {
        if (taskIDs.has(task.id))
            error("TASK_DUPLICATE", `duplicate task ${task.id}`, task.id);
        taskIDs.add(task.id);
        if (hasPlaceholder(task.title))
            error("PLACEHOLDER", `task ${task.id} title contains a placeholder`, task.id);
        if (task.files.length === 0)
            error("TASK_FILES_EMPTY", `task ${task.id} must name at least one file`, task.id);
        if (task.requirements.length === 0)
            error("TASK_REQUIREMENTS_EMPTY", `task ${task.id} must close at least one requirement`, task.id);
        if (task.checks.length === 0)
            error("TASK_CHECKS_EMPTY", `task ${task.id} must name at least one check`, task.id);
        if (new Set(task.files).size !== task.files.length)
            warning("TASK_FILE_DUPLICATE", `task ${task.id} repeats a file`, task.id);
        for (const requirementID of task.requirements) {
            if (!requirementIDs.has(requirementID))
                error("REQUIREMENT_UNKNOWN", `task ${task.id} references unknown ${requirementID}`, task.id);
            coveredRequirements.add(requirementID);
        }
        for (const checkID of task.checks) {
            if (!checkIDs.has(checkID))
                error("CHECK_UNKNOWN", `task ${task.id} references unknown ${checkID}`, task.id);
            referencedChecks.add(checkID);
        }
        for (const dependency of task.dependsOn) {
            if (dependency === task.id)
                error("TASK_SELF_DEPENDENCY", `task ${task.id} depends on itself`, task.id);
        }
    }
    for (const requirement of spec.requirements) {
        if (!coveredRequirements.has(requirement.id))
            error("REQUIREMENT_UNCOVERED", `${requirement.id} is not closed by any task`, requirement.id);
    }
    for (const check of spec.checks) {
        if (!referencedChecks.has(check.id))
            error("CHECK_UNREFERENCED", `${check.id} is not used by any task`, check.id);
    }
    for (const task of spec.tasks) {
        for (const dependency of task.dependsOn) {
            if (!taskIDs.has(dependency))
                error("TASK_DEPENDENCY_UNKNOWN", `task ${task.id} depends on unknown ${dependency}`, task.id);
        }
    }
    if (spec.nonGoals.length === 0)
        warning("NON_GOALS_EMPTY", "spec.nonGoals is empty; state what is explicitly out of scope");
    if (body.length < 80)
        warning("BODY_SHORT", "spec body is very short; explain design, decisions and risks");
    const cycle = findCycle(spec.tasks);
    if (cycle !== undefined)
        error("TASK_CYCLE", `task dependency cycle: ${cycle.join(" -> ")}`);
    if (strict) {
        if (spec.nonGoals.length === 0)
            error("NON_GOALS_EMPTY", "strict mode requires explicit non-goals");
        if (!spec.checks.some((check) => check.type === "command")) {
            error("NO_COMMAND_CHECK", "strict mode requires at least one command check");
        }
    }
    return diagnostics;
}
export function findCycle(tasks) {
    const byID = new Map(tasks.map((task) => [task.id, task]));
    const state = new Map();
    const stack = [];
    const visit = (id) => {
        const current = state.get(id);
        if (current === "done")
            return undefined;
        if (current === "visiting") {
            const start = stack.indexOf(id);
            return [...stack.slice(start), id];
        }
        state.set(id, "visiting");
        stack.push(id);
        const task = byID.get(id);
        for (const dependency of task?.dependsOn ?? []) {
            if (!byID.has(dependency))
                continue;
            const found = visit(dependency);
            if (found !== undefined)
                return found;
        }
        stack.pop();
        state.set(id, "done");
        return undefined;
    };
    for (const task of tasks) {
        const found = visit(task.id);
        if (found !== undefined)
            return found;
    }
    return undefined;
}
export async function verifySpecPaths(spec, workspace) {
    const diagnostics = [];
    for (const source of spec.sources) {
        const path = resolve(workspace, source.path);
        if (!isWithin(workspace, path)) {
            diagnostics.push({ severity: "error", code: "SOURCE_OUTSIDE", message: `source leaves workspace: ${source.path}` });
            continue;
        }
        try {
            const info = await stat(path);
            if (!info.isFile()) {
                diagnostics.push({ severity: "error", code: "SOURCE_NOT_FILE", message: `source is not a regular file: ${source.path}` });
                continue;
            }
            if (source.sha256 !== undefined) {
                const actual = sha256(await readFile(path));
                if (actual !== source.sha256) {
                    diagnostics.push({ severity: "error", code: "SOURCE_HASH", message: `source hash mismatch: ${source.path}` });
                }
            }
        }
        catch {
            diagnostics.push({ severity: "error", code: "SOURCE_MISSING", message: `source does not exist: ${source.path}` });
        }
    }
    return diagnostics;
}
export function assertValidSpec(parsed, strict) {
    const errors = lintSpec(parsed, strict).filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length > 0) {
        throw new UlwError("SPEC_INVALID", errors.map((entry) => `${entry.code}: ${entry.message}`).join("; "));
    }
}
export async function computeSourceHashes(spec, workspace) {
    const hashes = {};
    for (const source of spec.sources) {
        const path = resolve(workspace, source.path);
        if (!isWithin(workspace, path))
            throw new UlwError("SOURCE_OUTSIDE", `source leaves workspace: ${source.path}`);
        hashes[source.path] = sha256(await readFile(path));
    }
    return hashes;
}
//# sourceMappingURL=spec.js.map
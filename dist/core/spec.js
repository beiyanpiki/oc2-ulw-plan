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
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function report(diagnostics, code, message, entity) {
    diagnostics.push(entity === undefined ? { severity: "error", code, message } : { severity: "error", code, message, entity });
}
function capture(diagnostics, error, entity) {
    if (error instanceof UlwError)
        report(diagnostics, error.code, error.message, entity);
    else
        report(diagnostics, "SPEC_INVALID", error instanceof Error ? error.message : String(error), entity);
}
function rejectUnknownKeys(value, allowed, label, diagnostics) {
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            report(diagnostics, "SPEC_UNKNOWN_KEY", `${label}: unknown key ${JSON.stringify(key)} (allowed: ${[...allowed].join(", ")})`);
        }
    }
}
function readArray(value, label, diagnostics) {
    try {
        return expectArray(value, label);
    }
    catch (error) {
        capture(diagnostics, error);
        return undefined;
    }
}
function readString(value, label, diagnostics) {
    try {
        return expectString(value, label);
    }
    catch (error) {
        capture(diagnostics, error);
        return undefined;
    }
}
function readStringArray(value, label, diagnostics) {
    try {
        return expectStringArray(value, label);
    }
    catch (error) {
        capture(diagnostics, error);
        return undefined;
    }
}
function readSources(value, diagnostics) {
    const entries = readArray(value, "sources", diagnostics);
    if (entries === undefined)
        return undefined;
    let ok = true;
    const out = [];
    for (const [index, entry] of entries.entries()) {
        const label = `sources[${index}]`;
        if (!isRecord(entry)) {
            report(diagnostics, "SPEC_SHAPE", `${label} must be a mapping`, label);
            ok = false;
            continue;
        }
        rejectUnknownKeys(entry, SOURCE_KEYS, label, diagnostics);
        const rawPath = readString(entry.path, `${label}.path`, diagnostics);
        let path;
        if (rawPath !== undefined) {
            try {
                path = assertSafeRelativePath(rawPath, `${label}.path`);
            }
            catch (error) {
                capture(diagnostics, error, label);
            }
        }
        let sha;
        if (entry.sha256 !== undefined) {
            const raw = readString(entry.sha256, `${label}.sha256`, diagnostics);
            if (raw !== undefined) {
                if (!/^[a-f0-9]{64}$/.test(raw)) {
                    report(diagnostics, "SPEC_SOURCE_HASH", `${label}.sha256 must be a lowercase sha256`, label);
                    ok = false;
                }
                else {
                    sha = raw;
                }
            }
        }
        if (path === undefined) {
            ok = false;
            continue;
        }
        out.push(sha === undefined ? { path } : { path, sha256: sha });
    }
    return ok ? out : undefined;
}
function readRequirements(value, diagnostics) {
    const entries = readArray(value, "requirements", diagnostics);
    if (entries === undefined)
        return undefined;
    let ok = true;
    const out = [];
    for (const [index, entry] of entries.entries()) {
        const label = `requirements[${index}]`;
        if (!isRecord(entry)) {
            report(diagnostics, "SPEC_SHAPE", `${label} must be a mapping`, label);
            ok = false;
            continue;
        }
        rejectUnknownKeys(entry, REQUIREMENT_KEYS, label, diagnostics);
        const id = readString(entry.id, `${label}.id`, diagnostics);
        const text = readString(entry.text, `${label}.text`, diagnostics);
        if (id !== undefined && !/^R[1-9]\d*$/.test(id)) {
            report(diagnostics, "SPEC_ID", `${label}.id must match R<number> (for example R1): ${id}`, label);
            ok = false;
        }
        if (id === undefined || text === undefined) {
            ok = false;
            continue;
        }
        out.push({ id, text });
    }
    return ok ? out : undefined;
}
function readTasks(value, diagnostics) {
    const entries = readArray(value, "tasks", diagnostics);
    if (entries === undefined)
        return undefined;
    let ok = true;
    const out = [];
    for (const [index, entry] of entries.entries()) {
        const label = `tasks[${index}]`;
        if (!isRecord(entry)) {
            report(diagnostics, "SPEC_SHAPE", `${label} must be a mapping`, label);
            ok = false;
            continue;
        }
        rejectUnknownKeys(entry, TASK_KEYS, label, diagnostics);
        if (entry.acceptance !== undefined) {
            report(diagnostics, "SPEC_UNKNOWN_KEY", `${label}.acceptance is not a task field; put acceptance criteria in the task title or the Markdown body`, label);
        }
        const id = readString(entry.id, `${label}.id`, diagnostics);
        if (id !== undefined && !/^T[1-9]\d*$/.test(id)) {
            report(diagnostics, "SPEC_ID", `${label}.id must match T<number> (for example T1): ${id}`, label);
            ok = false;
        }
        const title = readString(entry.title, `${label}.title`, diagnostics);
        const rawFiles = readStringArray(entry.files, `${label}.files`, diagnostics);
        let files;
        if (rawFiles !== undefined) {
            files = [];
            for (const [fileIndex, path] of rawFiles.entries()) {
                try {
                    files.push(assertSafeRelativePath(path, `${label}.files[${fileIndex}]`));
                }
                catch (error) {
                    capture(diagnostics, error, label);
                    files = undefined;
                    break;
                }
            }
        }
        const requirements = readStringArray(entry.requirements, `${label}.requirements`, diagnostics);
        const dependsOn = entry.dependsOn === undefined ? [] : readStringArray(entry.dependsOn, `${label}.dependsOn`, diagnostics);
        const checks = readStringArray(entry.checks, `${label}.checks`, diagnostics);
        if (id === undefined || title === undefined || files === undefined || requirements === undefined || dependsOn === undefined || checks === undefined) {
            ok = false;
            continue;
        }
        out.push({ id, title, requirements, dependsOn, files, checks });
    }
    return ok ? out : undefined;
}
function readExpectation(value, label, diagnostics) {
    if (value === undefined)
        return { exitCode: 0, stdoutIncludes: [], stderrIncludes: [] };
    if (!isRecord(value)) {
        report(diagnostics, "SPEC_SHAPE", `${label} must be a mapping`, label);
        return undefined;
    }
    rejectUnknownKeys(value, EXPECT_KEYS, label, diagnostics);
    const rawExitCode = value.exitCode === undefined ? 0 : Number(value.exitCode);
    if (!Number.isInteger(rawExitCode) || rawExitCode < 0 || rawExitCode > 255) {
        report(diagnostics, "SPEC_CHECK", `${label}.exitCode must be an integer between 0 and 255`, label);
        return undefined;
    }
    const stdoutIncludes = value.stdoutIncludes === undefined ? [] : readStringArray(value.stdoutIncludes, `${label}.stdoutIncludes`, diagnostics);
    const stderrIncludes = value.stderrIncludes === undefined ? [] : readStringArray(value.stderrIncludes, `${label}.stderrIncludes`, diagnostics);
    if (stdoutIncludes === undefined || stderrIncludes === undefined)
        return undefined;
    return { exitCode: rawExitCode, stdoutIncludes, stderrIncludes };
}
function readChecks(value, diagnostics) {
    const entries = readArray(value, "checks", diagnostics);
    if (entries === undefined)
        return undefined;
    let ok = true;
    const out = [];
    for (const [index, entry] of entries.entries()) {
        const label = `checks[${index}]`;
        if (!isRecord(entry)) {
            report(diagnostics, "SPEC_SHAPE", `${label} must be a mapping`, label);
            ok = false;
            continue;
        }
        const id = readString(entry.id, `${label}.id`, diagnostics);
        if (id !== undefined && !/^V[1-9]\d*$/.test(id)) {
            report(diagnostics, "SPEC_ID", `${label}.id must match V<number> (for example V1): ${id}`, label);
            ok = false;
        }
        const type = readString(entry.type, `${label}.type`, diagnostics);
        const allowedKeys = type === "command" ? COMMAND_CHECK_KEYS : type === "procedure" ? PROCEDURE_CHECK_KEYS : new Set([...COMMAND_CHECK_KEYS, ...PROCEDURE_CHECK_KEYS]);
        rejectUnknownKeys(entry, allowedKeys, label, diagnostics);
        if (entry.type === undefined && entry.kind !== undefined) {
            report(diagnostics, "SPEC_UNKNOWN_KEY", `${label}: use "type: command|procedure" instead of "kind"; command checks take argv, and expect.exitCode instead of expectExitCode`, label);
        }
        if (type === "command") {
            const argv = readStringArray(entry.argv, `${label}.argv`, diagnostics);
            if (argv !== undefined && argv.length === 0) {
                report(diagnostics, "SPEC_CHECK", `${label}.argv must not be empty`, label);
            }
            const rawCwd = entry.cwd === undefined ? "." : readString(entry.cwd, `${label}.cwd`, diagnostics);
            let cwd;
            if (rawCwd !== undefined) {
                try {
                    cwd = assertSafeRelativePath(rawCwd, `${label}.cwd`);
                }
                catch (error) {
                    capture(diagnostics, error, label);
                }
            }
            const rawTimeout = entry.timeoutMs === undefined ? DEFAULT_CHECK_TIMEOUT_MS : Number(entry.timeoutMs);
            if (!Number.isInteger(rawTimeout) || rawTimeout < 1 || rawTimeout > MAX_CHECK_TIMEOUT_MS) {
                report(diagnostics, "SPEC_CHECK", `${label}.timeoutMs must be 1..${MAX_CHECK_TIMEOUT_MS}`, label);
                ok = false;
            }
            const expect = readExpectation(entry.expect, `${label}.expect`, diagnostics);
            if (id === undefined || argv === undefined || argv.length === 0 || cwd === undefined || expect === undefined) {
                ok = false;
                continue;
            }
            out.push({
                id,
                type: "command",
                description: entry.description === undefined ? `Command check ${id}` : (readString(entry.description, `${label}.description`, diagnostics) ?? `Command check ${id}`),
                argv,
                cwd,
                timeoutMs: rawTimeout,
                expect,
            });
            continue;
        }
        if (type === "procedure") {
            const steps = readStringArray(entry.steps, `${label}.steps`, diagnostics);
            if (steps !== undefined && steps.length === 0) {
                report(diagnostics, "SPEC_CHECK", `${label}.steps must not be empty`, label);
            }
            const expected = readString(entry.expected, `${label}.expected`, diagnostics);
            const requiredTools = entry.requiredTools === undefined ? [] : readStringArray(entry.requiredTools, `${label}.requiredTools`, diagnostics);
            if (id === undefined || steps === undefined || steps.length === 0 || expected === undefined || requiredTools === undefined) {
                ok = false;
                continue;
            }
            out.push({
                id,
                type: "procedure",
                description: entry.description === undefined ? `Procedure check ${id}` : (readString(entry.description, `${label}.description`, diagnostics) ?? `Procedure check ${id}`),
                steps,
                expected,
                requiredTools,
            });
            continue;
        }
        if (type !== undefined) {
            report(diagnostics, "SPEC_CHECK", `${label}.type must be "command" or "procedure", got ${JSON.stringify(type)}`, label);
        }
        ok = false;
    }
    return ok ? out : undefined;
}
function readReview(value, diagnostics) {
    if (value === undefined)
        return { risk: "low", requireAdversarial: false };
    if (!isRecord(value)) {
        report(diagnostics, "SPEC_SHAPE", "review must be a mapping", "review");
        return undefined;
    }
    rejectUnknownKeys(value, REVIEW_KEYS, "review", diagnostics);
    const rawRisk = value.risk === undefined ? "low" : readString(value.risk, "review.risk", diagnostics);
    let risk;
    if (rawRisk !== undefined) {
        if (!["low", "medium", "high"].includes(rawRisk)) {
            report(diagnostics, "SPEC_REVIEW", 'review.risk must be "low", "medium" or "high"', "review");
        }
        else {
            risk = rawRisk;
        }
    }
    const requireAdversarial = value.requireAdversarial === undefined ? false : value.requireAdversarial;
    if (typeof requireAdversarial !== "boolean") {
        report(diagnostics, "SPEC_REVIEW", "review.requireAdversarial must be boolean", "review");
        return undefined;
    }
    if (risk === undefined)
        return undefined;
    return { risk, requireAdversarial };
}
/**
 * Parse a spec and collect every structural error instead of failing fast. The
 * returned `parsed` is only present when the file is structurally valid; lint
 * diagnostics are deliberately left to the caller so `parseSpec` keeps its
 * historical meaning.
 */
export function analyzeSpec(content) {
    const hash = sha256(content);
    const diagnostics = [];
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_SPEC_BYTES) {
        report(diagnostics, "SPEC_TOO_LARGE", `spec exceeds ${MAX_SPEC_BYTES} bytes`);
        return { diagnostics, hash };
    }
    let yaml;
    let body;
    try {
        ({ yaml, body } = parseFrontmatter(content));
    }
    catch (error) {
        capture(diagnostics, error);
        return { diagnostics, hash };
    }
    const document = parseDocument(yaml, { uniqueKeys: true, prettyErrors: true });
    if (document.errors.length > 0) {
        for (const error of document.errors)
            report(diagnostics, "SPEC_YAML", error.message);
        return { diagnostics, hash };
    }
    const raw = document.toJS({ maxAliasCount: 0 });
    if (!isRecord(raw)) {
        report(diagnostics, "SPEC_SHAPE", "spec must be a mapping");
        return { diagnostics, hash };
    }
    rejectUnknownKeys(raw, TOP_KEYS, "spec", diagnostics);
    for (const key of ["schema", "id", "title", "requirements", "tasks", "checks"]) {
        if (raw[key] === undefined)
            report(diagnostics, "SPEC_MISSING", `spec.${key} is required`);
    }
    const schema = readString(raw.schema, "spec.schema", diagnostics);
    if (schema !== undefined && schema !== SPEC_SCHEMA) {
        report(diagnostics, "SPEC_SCHEMA", `unsupported spec schema: ${schema}; expected ${SPEC_SCHEMA}`);
    }
    const id = readString(raw.id, "spec.id", diagnostics);
    if (id !== undefined && !isSpecSlug(id)) {
        report(diagnostics, "SPEC_ID", "spec.id must be a lowercase kebab-case slug up to 80 characters");
    }
    const title = readString(raw.title, "spec.title", diagnostics);
    const sources = raw.sources === undefined ? [] : readSources(raw.sources, diagnostics);
    const requirements = readRequirements(raw.requirements, diagnostics);
    const nonGoals = raw.nonGoals === undefined ? [] : readStringArray(raw.nonGoals, "spec.nonGoals", diagnostics);
    const tasks = readTasks(raw.tasks, diagnostics);
    const checks = readChecks(raw.checks, diagnostics);
    const review = readReview(raw.review, diagnostics);
    const declaredID = typeof raw.id === "string" ? raw.id : undefined;
    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
        return { diagnostics, hash, ...(declaredID === undefined ? {} : { declaredID }) };
    }
    if (schema === undefined ||
        id === undefined ||
        title === undefined ||
        sources === undefined ||
        requirements === undefined ||
        nonGoals === undefined ||
        tasks === undefined ||
        checks === undefined ||
        review === undefined) {
        report(diagnostics, "SPEC_INVALID", "spec could not be parsed completely");
        return { diagnostics, hash, ...(declaredID === undefined ? {} : { declaredID }) };
    }
    const spec = {
        schema: SPEC_SCHEMA,
        id,
        title,
        sources,
        requirements,
        nonGoals,
        tasks,
        checks,
        review,
    };
    return {
        parsed: { spec, body, sha256: hash, content },
        diagnostics,
        hash,
        ...(declaredID === undefined ? {} : { declaredID }),
    };
}
export function parseSpec(content) {
    const analysis = analyzeSpec(content);
    const errors = analysis.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (analysis.parsed === undefined || errors.length > 0) {
        throw new UlwError("SPEC_INVALID", errors.length === 0 ? "spec could not be parsed" : errors.map((entry) => `${entry.code}: ${entry.message}`).join("; "));
    }
    return analysis.parsed;
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
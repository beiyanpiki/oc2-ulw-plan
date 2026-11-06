import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { UlwError } from "../core/errors.js";
import { SPEC_SCHEMA_GUIDE } from "../core/guide.js";
import { analyzeSpec, computeSourceHashes, effectiveRisk, hasPlaceholder, isSpecSlug, isWithin, lintSpec, sha256, verifySpecPaths } from "../core/spec.js";
import { createPendingSpecRecord, createSpecRecord, loadSpecRecord, publishRecord, saveSpecRecord, setStatus, verifyPlanReview } from "../core/spec-record.js";
import { atomicWriteFile, ensureArtifactDir, readFilePage } from "../io/paths.js";
function draftSkeleton(id, request, intent) {
    return `---
id: ${id}
intent: ${intent}
---

# Draft: ${id}

## Request

${request}

## Findings

## Decisions

## Risks and open questions

## Next step

Write the executable spec through \`ulw_spec action=write\`, validate it, obtain an independent practical review, and publish.

Run \`ulw_spec action=template\` for the exact key reference, or call
\`ulw_spec action=begin\` again to print it. Task ids are T1, requirement ids are
R1 and check ids are V1 (not C1).
`;
}
function errorText(diagnostics) {
    return diagnostics
        .filter((diagnostic) => diagnostic.severity === "error")
        .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
        .join("; ");
}
export class SpecService {
    runtime;
    constructor(runtime) {
        this.runtime = runtime;
    }
    async paths(workspace) {
        const specs = await ensureArtifactDir(workspace, "specs");
        const drafts = await ensureArtifactDir(workspace, "drafts");
        return { specs, drafts };
    }
    async begin(input, sessionID) {
        if (!isSpecSlug(input.id))
            throw new UlwError("SPEC_ID", "id must be a lowercase kebab-case slug");
        const { workspace } = await this.runtime.workspaceOfSession(sessionID);
        const { specs, drafts } = await this.paths(workspace);
        const store = this.runtime.store(workspace);
        const plan = await store.getPlan(sessionID);
        const strict = input.strict === true || plan?.strict === true;
        const draftPath = join(drafts, `${input.id}.md`);
        const specPath = join(specs, `${input.id}.md`);
        let record = await store.getSpec(input.id);
        if (record === undefined) {
            record = createSpecRecord({
                spec: {
                    schema: "ulw-spec/v1",
                    id: input.id,
                    title: input.id,
                    sources: [],
                    requirements: [],
                    nonGoals: [],
                    tasks: [],
                    checks: [],
                    review: { risk: "low", requireAdversarial: false },
                },
                body: "",
                sha256: "",
                content: "",
            }, workspace, {}, strict, strict);
            record.status = "draft";
            await saveSpecRecord(store, record);
        }
        else {
            let changed = false;
            if (strict && !record.requireAdversarial) {
                record.requireAdversarial = true;
                changed = true;
            }
            if (strict && record.strict !== true) {
                record.strict = true;
                changed = true;
            }
            if (changed)
                await saveSpecRecord(store, record);
        }
        try {
            await readFile(draftPath);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            await atomicWriteFile(draftPath, draftSkeleton(input.id, input.request ?? "(fill the request)", input.intent ?? "clear"));
        }
        return { id: input.id, draftPath, specPath, status: record.status, template: SPEC_SCHEMA_GUIDE };
    }
    /**
     * Persist the spec even when it is not valid yet. This is deliberate: a
     * planner can then repair a 20 KB document with a small `action=patch`
     * instead of regenerating the whole file after the first validation error.
     * Invalid content never leaves `draft` status and can never be published or
     * executed.
     */
    async write(input, sessionID) {
        if (!isSpecSlug(input.id))
            throw new UlwError("SPEC_ID", "id must be a lowercase kebab-case slug");
        const { workspace } = await this.runtime.workspaceOfSession(sessionID);
        const analysis = analyzeSpec(input.content);
        if (analysis.declaredID !== undefined && analysis.declaredID !== input.id) {
            throw new UlwError("SPEC_ID", `spec content id ${JSON.stringify(analysis.declaredID)} does not match the write target ${JSON.stringify(input.id)}`);
        }
        const { specs } = await this.paths(workspace);
        const path = join(specs, `${input.id}.md`);
        const store = this.runtime.store(workspace);
        const plan = await store.getPlan(sessionID);
        const strict = input.strict === true || plan?.strict === true;
        await this.runtime.withMutex(`spec:${workspace}:${input.id}`, async () => {
            const record = await store.getSpec(input.id);
            if (record?.status === "ready" && record.contentHash !== analysis.hash) {
                throw new UlwError("SPEC_READY", "the published spec is frozen; call ulw_spec action=reopen before revising it");
            }
            if (input.expectedHash !== undefined && record?.contentHash !== input.expectedHash) {
                throw new UlwError("SPEC_CONFLICT", "spec record changed since it was read");
            }
            await atomicWriteFile(path, input.content);
            let next;
            if (record === undefined) {
                next = createPendingSpecRecord(input.id, workspace, analysis.hash, strict);
            }
            else {
                next = record;
                if (next.contentHash !== analysis.hash) {
                    delete next.practical;
                    delete next.adversarial;
                    next.status = "draft";
                }
                if (strict) {
                    next.strict = true;
                    next.requireAdversarial = true;
                }
                next.contentHash = analysis.hash;
                if (analysis.parsed !== undefined) {
                    next.sourceHashes = await computeSourceHashes(analysis.parsed.spec, workspace);
                    next.risk = effectiveRisk(analysis.parsed.spec, analysis.parsed.body);
                }
            }
            await saveSpecRecord(store, next);
        });
        return this.validate(input.id, sessionID);
    }
    /**
     * Apply targeted edits to the current spec. Every `old` must match exactly
     * once unless `replaceAll` is set, so an ambiguous patch fails instead of
     * silently changing the wrong task.
     */
    async patch(input, sessionID) {
        if (!isSpecSlug(input.id))
            throw new UlwError("SPEC_ID", "id must be a lowercase kebab-case slug");
        if (!Array.isArray(input.edits) || input.edits.length === 0) {
            throw new UlwError("PATCH_EMPTY", "patch needs at least one edit");
        }
        if (input.edits.length > 100)
            throw new UlwError("PATCH_LIMIT", "patch accepts at most 100 edits");
        const { workspace } = await this.runtime.workspaceOfSession(sessionID);
        const file = await this.runtime.loadSpec(input.id, workspace);
        if (file === undefined)
            throw new UlwError("SPEC_NOT_FOUND", `no spec file: ${input.id}; call ulw_spec action=write first`);
        let content = file.content;
        for (const [index, edit] of input.edits.entries()) {
            if (typeof edit.old !== "string" || edit.old === "") {
                throw new UlwError("PATCH_SHAPE", `edits[${index}].old must be a non-empty string`);
            }
            if (typeof edit.new !== "string") {
                throw new UlwError("PATCH_SHAPE", `edits[${index}].new must be a string`);
            }
            const occurrences = content.split(edit.old).length - 1;
            if (occurrences === 0) {
                throw new UlwError("PATCH_MISS", `edits[${index}].old was not found; read the current spec and include exact surrounding text`);
            }
            if (occurrences > 1 && edit.replaceAll !== true) {
                throw new UlwError("PATCH_AMBIGUOUS", `edits[${index}].old occurs ${occurrences} times; include more context or set replaceAll=true`);
            }
            content = edit.replaceAll === true ? content.split(edit.old).join(edit.new) : content.replace(edit.old, edit.new);
        }
        return this.write({
            id: input.id,
            content,
            ...(input.strict === undefined ? {} : { strict: input.strict }),
            ...(input.expectedHash === undefined ? {} : { expectedHash: input.expectedHash }),
        }, sessionID);
    }
    async validate(id, sessionID) {
        if (!isSpecSlug(id))
            throw new UlwError("SPEC_ID", "invalid spec id");
        const { workspace } = await this.runtime.workspaceOfSession(sessionID);
        const file = await this.runtime.loadSpec(id, workspace);
        if (file === undefined)
            throw new UlwError("SPEC_NOT_FOUND", `no spec file: ${id}`);
        const analysis = analyzeSpec(file.content);
        const store = this.runtime.store(workspace);
        return this.runtime.withMutex(`spec:${workspace}:${id}`, async () => {
            const record = await store.getSpec(id);
            const strict = record?.strict === true;
            const diagnostics = [...analysis.diagnostics];
            if (analysis.parsed !== undefined) {
                diagnostics.push(...lintSpec(analysis.parsed, strict));
                diagnostics.push(...(await verifySpecPaths(analysis.parsed.spec, workspace)));
            }
            if (record !== undefined) {
                if (record.contentHash !== analysis.hash) {
                    diagnostics.push({ severity: "error", code: "SPEC_RECORD_STALE", message: "spec record does not match the file; write it again" });
                }
                else if (diagnostics.every((diagnostic) => diagnostic.severity !== "error") && record.status !== "ready" && analysis.parsed !== undefined) {
                    setStatus(record, "validating");
                    record.risk = effectiveRisk(analysis.parsed.spec, analysis.parsed.body);
                    record.strict = strict;
                    await saveSpecRecord(store, record);
                }
            }
            return {
                valid: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
                diagnostics,
                hash: analysis.hash,
                path: file.path,
            };
        });
    }
    async publish(id, sessionID) {
        if (!isSpecSlug(id))
            throw new UlwError("SPEC_ID", "invalid spec id");
        const { workspace } = await this.runtime.workspaceOfSession(sessionID);
        const store = this.runtime.store(workspace);
        return this.runtime.withMutex(`spec:${workspace}:${id}`, async () => {
            const record = await loadSpecRecord(store, id);
            const file = await this.runtime.loadSpec(id, workspace);
            if (file === undefined)
                throw new UlwError("SPEC_NOT_FOUND", `no spec file: ${id}`);
            const analysis = analyzeSpec(file.content);
            if (analysis.parsed === undefined) {
                throw new UlwError("SPEC_INVALID", errorText(analysis.diagnostics) || "spec is not structurally valid");
            }
            const strict = record.strict === true;
            const diagnostics = [...analysis.diagnostics, ...lintSpec(analysis.parsed, strict), ...(await verifySpecPaths(analysis.parsed.spec, workspace))];
            const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
            if (errors.length > 0) {
                throw new UlwError("SPEC_INVALID", errorText(errors));
            }
            if (record.contentHash !== analysis.hash)
                throw new UlwError("SPEC_CONFLICT", "spec file differs from the validated record");
            const sourceHashes = await computeSourceHashes(analysis.parsed.spec, workspace);
            for (const [path, hash] of Object.entries(record.sourceHashes)) {
                if (sourceHashes[path] !== hash)
                    throw new UlwError("SOURCE_STALE", `source changed after the spec was written: ${path}`);
            }
            record.sourceHashes = sourceHashes;
            const practical = await verifyPlanReview(store, record, "practical");
            if (!practical.ok)
                throw new UlwError("SPEC_NOT_APPROVED", practical.reason);
            if (record.requireAdversarial || record.risk === "high") {
                const adversarial = await verifyPlanReview(store, record, "adversarial");
                if (!adversarial.ok)
                    throw new UlwError("SPEC_NOT_APPROVED", adversarial.reason);
            }
            publishRecord(record, analysis.parsed, record.requireAdversarial);
            await saveSpecRecord(store, record);
            return {
                id: record.id,
                path: file.path,
                hash: analysis.hash,
                risk: record.risk,
                status: record.status,
                reviews: {
                    ...(record.practical === undefined ? {} : { practical: record.practical.verdict }),
                    ...(record.adversarial === undefined ? {} : { adversarial: record.adversarial.verdict }),
                },
            };
        });
    }
    async reopen(id, sessionID) {
        if (!isSpecSlug(id))
            throw new UlwError("SPEC_ID", "invalid spec id");
        const { workspace } = await this.runtime.workspaceOfSession(sessionID);
        const store = this.runtime.store(workspace);
        return this.runtime.withMutex(`spec:${workspace}:${id}`, async () => {
            const record = await loadSpecRecord(store, id);
            record.status = "draft";
            delete record.practical;
            delete record.adversarial;
            await saveSpecRecord(store, record);
            return record;
        });
    }
    async read(id, sessionID, kind, offset, limit) {
        if (!isSpecSlug(id))
            throw new UlwError("SPEC_ID", "invalid spec id");
        const { workspace } = await this.runtime.workspaceOfSession(sessionID);
        const directory = kind === "spec" ? "specs" : "drafts";
        const path = join(workspace, ".opencode", "ulw", directory, `${id}.md`);
        let page;
        try {
            page = await readFilePage(path, offset, limit);
        }
        catch (error) {
            if (error.code === "ENOENT") {
                throw new UlwError("SPEC_NOT_FOUND", `no ${kind} file: ${id}`);
            }
            throw error;
        }
        return { ...page, path };
    }
    async list(sessionID) {
        const { workspace } = await this.runtime.workspaceOfSession(sessionID);
        const { specs, drafts } = await this.paths(workspace);
        const specIDs = new Set((await readdir(specs)).filter((entry) => entry.endsWith(".md")).map((entry) => entry.slice(0, -3)).filter(isSpecSlug));
        const draftIDs = new Set((await readdir(drafts)).filter((entry) => entry.endsWith(".md")).map((entry) => entry.slice(0, -3)).filter(isSpecSlug));
        const store = this.runtime.store(workspace);
        const result = [];
        for (const id of [...new Set([...specIDs, ...draftIDs])].sort()) {
            const record = await store.getSpec(id);
            const hasSpec = specIDs.has(id);
            const hasDraft = draftIDs.has(id);
            result.push({
                id,
                kind: hasSpec && hasDraft ? "spec+draft" : hasSpec ? "spec" : "draft",
                status: record?.status ?? (hasSpec ? "unrecorded" : "draft"),
                hash: record?.contentHash ?? "",
                risk: record?.risk ?? "unknown",
                reviews: [record?.practical?.verdict, record?.adversarial?.verdict].filter(Boolean).join(", ") || "none",
            });
        }
        return result;
    }
    async status(id, sessionID) {
        if (!isSpecSlug(id))
            throw new UlwError("SPEC_ID", "invalid spec id");
        const { workspace } = await this.runtime.workspaceOfSession(sessionID);
        const store = this.runtime.store(workspace);
        const record = await store.getSpec(id);
        if (record !== undefined)
            return record;
        const draftPath = join(workspace, ".opencode", "ulw", "drafts", `${id}.md`);
        try {
            const content = await readFile(draftPath, "utf8");
            return createPendingSpecRecord(id, workspace, sha256(content), false);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            throw new UlwError("SPEC_NOT_FOUND", `no spec record: ${id}; call ulw_spec action=begin or action=write first`);
        }
    }
    async validateCurrent(id, workspace, strict = false) {
        const file = await this.runtime.loadSpec(id, workspace);
        if (file === undefined)
            throw new UlwError("SPEC_NOT_FOUND", `no spec file: ${id}`);
        const analysis = analyzeSpec(file.content);
        if (analysis.parsed === undefined) {
            throw new UlwError("SPEC_INVALID", errorText(analysis.diagnostics) || "spec is not structurally valid");
        }
        const diagnostics = [...analysis.diagnostics, ...lintSpec(analysis.parsed, strict), ...(await verifySpecPaths(analysis.parsed.spec, workspace))];
        const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
        return { parsed: analysis.parsed, diagnostics, errors };
    }
    async roughDraft(path, sessionID) {
        const { workspace } = await this.runtime.workspaceOfSession(sessionID);
        const absolute = join(workspace, path);
        if (!isWithin(workspace, absolute))
            throw new UlwError("PATH_TRAVERSAL", "draft path leaves the workspace");
        const content = await readFile(absolute, "utf8");
        return { content, placeholders: hasPlaceholder(content) };
    }
}
//# sourceMappingURL=spec-service.js.map
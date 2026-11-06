import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { UlwError } from "../core/errors.js";
import { computeSourceHashes, effectiveRisk, hasPlaceholder, isSpecSlug, isWithin, lintSpec, parseSpec, verifySpecPaths } from "../core/spec.js";
import { createSpecRecord, loadSpecRecord, publishRecord, saveSpecRecord, setStatus, verifyPlanReview } from "../core/spec-record.js";
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
`;
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
        const { drafts } = await this.paths(workspace);
        const store = this.runtime.store(workspace);
        const plan = await store.getPlan(sessionID);
        const strict = input.strict === true || plan?.strict === true;
        const draftPath = join(drafts, `${input.id}.md`);
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
            }, workspace, {}, strict);
            record.status = "draft";
            await saveSpecRecord(store, record);
        }
        else if (strict && !record.requireAdversarial) {
            record.requireAdversarial = true;
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
        return { id: input.id, draftPath, status: record.status };
    }
    async write(input, sessionID) {
        const { workspace } = await this.runtime.workspaceOfSession(sessionID);
        const parsed = parseSpec(input.content);
        if (parsed.spec.id !== input.id)
            throw new UlwError("SPEC_ID", "spec content id does not match the write target");
        const { specs } = await this.paths(workspace);
        const path = join(specs, `${input.id}.md`);
        const store = this.runtime.store(workspace);
        const plan = await store.getPlan(sessionID);
        const strict = input.strict === true || plan?.strict === true;
        await this.runtime.withMutex(`spec:${workspace}:${input.id}`, async () => {
            let record = await store.getSpec(input.id);
            if (record === undefined) {
                const sourceHashes = await computeSourceHashes(parsed.spec, workspace);
                record = createSpecRecord(parsed, workspace, sourceHashes, strict);
            }
            else {
                if (record.status === "ready" && record.contentHash !== parsed.sha256) {
                    throw new UlwError("SPEC_READY", "the published spec is frozen; call ulw_spec action=reopen before revising it");
                }
                if (input.expectedHash !== undefined && record.contentHash !== input.expectedHash) {
                    throw new UlwError("SPEC_CONFLICT", "spec record changed since it was read");
                }
                if (record.contentHash !== parsed.sha256) {
                    const sourceHashes = await computeSourceHashes(parsed.spec, workspace);
                    record = {
                        ...createSpecRecord(parsed, workspace, sourceHashes, strict || record.requireAdversarial),
                        createdAt: record.createdAt,
                        rounds: record.rounds,
                    };
                }
                else if (strict) {
                    record.requireAdversarial = true;
                }
            }
            await atomicWriteFile(path, input.content);
            record.contentHash = parsed.sha256;
            record.risk = effectiveRisk(parsed.spec, parsed.body);
            await saveSpecRecord(store, record);
        });
        return this.validate(input.id, sessionID);
    }
    async validate(id, sessionID) {
        if (!isSpecSlug(id))
            throw new UlwError("SPEC_ID", "invalid spec id");
        const { workspace } = await this.runtime.workspaceOfSession(sessionID);
        const file = await this.runtime.loadSpec(id, workspace);
        if (file === undefined)
            throw new UlwError("SPEC_NOT_FOUND", `no spec file: ${id}`);
        const parsed = parseSpec(file.content);
        const diagnostics = lintSpec(parsed, false);
        diagnostics.push(...(await verifySpecPaths(parsed.spec, workspace)));
        const store = this.runtime.store(workspace);
        return this.runtime.withMutex(`spec:${workspace}:${id}`, async () => {
            const record = await store.getSpec(id);
            if (record !== undefined) {
                if (record.contentHash !== parsed.sha256) {
                    diagnostics.push({ severity: "error", code: "SPEC_RECORD_STALE", message: "spec record does not match the file; write it again" });
                }
                else if (diagnostics.every((diagnostic) => diagnostic.severity !== "error") && record.status !== "ready") {
                    setStatus(record, "validating");
                    record.risk = effectiveRisk(parsed.spec, parsed.body);
                    await saveSpecRecord(store, record);
                }
            }
            return {
                valid: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
                diagnostics,
                hash: parsed.sha256,
                path: file.path,
            };
        });
    }
    async publish(id, sessionID) {
        if (!isSpecSlug(id))
            throw new UlwError("SPEC_ID", "invalid spec id");
        const { workspace } = await this.runtime.workspaceOfSession(sessionID);
        const file = await this.runtime.loadSpec(id, workspace);
        if (file === undefined)
            throw new UlwError("SPEC_NOT_FOUND", `no spec file: ${id}`);
        const parsed = parseSpec(file.content);
        const diagnostics = [...lintSpec(parsed, false), ...(await verifySpecPaths(parsed.spec, workspace))];
        const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
        if (errors.length > 0) {
            throw new UlwError("SPEC_INVALID", errors.map((entry) => `${entry.code}: ${entry.message}`).join("; "));
        }
        const store = this.runtime.store(workspace);
        return this.runtime.withMutex(`spec:${workspace}:${id}`, async () => {
            const record = await loadSpecRecord(store, id);
            if (record.contentHash !== parsed.sha256)
                throw new UlwError("SPEC_CONFLICT", "spec file differs from the validated record");
            const sourceHashes = await computeSourceHashes(parsed.spec, workspace);
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
            publishRecord(record, parsed, record.requireAdversarial);
            await saveSpecRecord(store, record);
            return {
                id: record.id,
                path: file.path,
                hash: parsed.sha256,
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
        const page = await readFilePage(path, offset, limit);
        return { ...page, path };
    }
    async list(sessionID) {
        const { workspace } = await this.runtime.workspaceOfSession(sessionID);
        const { specs } = await this.paths(workspace);
        const entries = await readdir(specs);
        const store = this.runtime.store(workspace);
        const result = [];
        for (const entry of entries) {
            if (!entry.endsWith(".md"))
                continue;
            const id = entry.slice(0, -3);
            if (!isSpecSlug(id))
                continue;
            const record = await store.getSpec(id);
            result.push({
                id,
                status: record?.status ?? "unrecorded",
                hash: record?.contentHash ?? "",
                risk: record?.risk ?? "unknown",
                reviews: [record?.practical?.verdict, record?.adversarial?.verdict].filter(Boolean).join(", ") || "none",
            });
        }
        return result.sort((left, right) => left.id.localeCompare(right.id));
    }
    async status(id, sessionID) {
        if (!isSpecSlug(id))
            throw new UlwError("SPEC_ID", "invalid spec id");
        const { workspace } = await this.runtime.workspaceOfSession(sessionID);
        return loadSpecRecord(this.runtime.store(workspace), id);
    }
    async validateCurrent(id, workspace) {
        const file = await this.runtime.loadSpec(id, workspace);
        if (file === undefined)
            throw new UlwError("SPEC_NOT_FOUND", `no spec file: ${id}`);
        const parsed = parseSpec(file.content);
        const diagnostics = [...lintSpec(parsed, false), ...(await verifySpecPaths(parsed.spec, workspace))];
        const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
        return { parsed, diagnostics, errors };
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
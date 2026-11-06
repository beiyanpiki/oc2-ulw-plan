import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { UlwError } from "../core/errors.js";
import { atomicWriteFile, ensureArtifactDir } from "../io/paths.js";
const exec = promisify(execFile);
async function git(cwd, ...args) {
    const { stdout } = await exec("git", ["-C", cwd, ...args]);
    return stdout.trim();
}
async function gitCommonDir(path) {
    const common = await git(path, "rev-parse", "--git-common-dir").catch(() => "");
    if (common === "")
        throw new UlwError("NOT_GIT", `not a Git worktree: ${path}`);
    const absolute = isAbsolute(common) ? common : resolve(path, common);
    return realpath(absolute).catch(() => resolve(absolute));
}
export async function prepareWorktree(ctx, runtime, canonical, specId, request) {
    let directory;
    if (request === "auto") {
        const projectID = ctx.location.project.id;
        const created = await ctx.worktree.create({ projectID, name: `ulw-${specId}` });
        directory = await realpath(created.directory);
    }
    else {
        directory = await realpath(isAbsolute(request) ? request : resolve(canonical, request)).catch(() => {
            throw new UlwError("WORKTREE_MISSING", `worktree does not exist: ${request}`);
        });
        const info = await stat(directory);
        if (!info.isDirectory())
            throw new UlwError("WORKTREE_NOT_DIR", `worktree is not a directory: ${directory}`);
        const root = await git(directory, "rev-parse", "--show-toplevel").catch(() => "");
        if (root === "" || (await realpath(root)) !== directory) {
            throw new UlwError("WORKTREE_ROOT", `worktree path must be the repository root: ${directory}`);
        }
    }
    if ((await gitCommonDir(directory)) !== (await gitCommonDir(canonical))) {
        throw new UlwError("WORKTREE_REPO", "worktree belongs to a different Git repository");
    }
    await copySpecToWorktree(runtime, canonical, directory, specId);
    return directory;
}
async function copySpecToWorktree(runtime, canonical, target, specId) {
    const source = await runtime.loadSpec(specId, canonical);
    if (source === undefined)
        throw new UlwError("SPEC_NOT_FOUND", `no spec file: ${specId}`);
    const sourceRecord = await runtime.store(canonical).getSpec(specId);
    if (sourceRecord === undefined)
        throw new UlwError("SPEC_NOT_FOUND", `no spec record: ${specId}`);
    const targetRecord = await runtime.store(target).getSpec(specId);
    if (targetRecord !== undefined && targetRecord.contentHash !== sourceRecord.contentHash) {
        throw new UlwError("WORKTREE_SPEC_CONFLICT", "the worktree already has a different spec record for this id");
    }
    const specs = await ensureArtifactDir(target, "specs");
    await atomicWriteFile(join(specs, `${specId}.md`), source.content);
    await runtime.store(target).setSpec(specId, sourceRecord);
}
//# sourceMappingURL=worktree.js.map
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { UlwError } from "../core/errors.js";
import { SPEC_SCHEMA_GUIDE } from "../core/guide.js";
import { isWithin, isSpecSlug } from "../core/spec.js";
import { DiagnoseService } from "./diagnose-service.js";
import { SpecService } from "./spec-service.js";
import { RunService } from "./run-service.js";
import { RoleService } from "./roles.js";
import { prepareWorktree } from "./worktree.js";
function parseArgs(text, valueFlags, flags) {
    const tokens = text.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    const positionals = [];
    const set = new Set();
    const values = new Map();
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (valueFlags.includes(token)) {
            const value = tokens[index + 1];
            if (value === undefined)
                throw new UlwError("ARGS", `${token} needs a value`);
            values.set(token, value.replace(/^["']|["']$/g, ""));
            index += 1;
        }
        else if (flags.includes(token)) {
            set.add(token);
        }
        else {
            positionals.push(token.replace(/^["']|["']$/g, ""));
        }
    }
    return { positionals, flags: set, values };
}
function commandText(invocation) {
    return invocation.prompt.text.trim();
}
function promptRequest(invocation, text) {
    return {
        sessionID: invocation.sessionID,
        text,
        delivery: invocation.delivery,
        ...(invocation.prompt.files === undefined ? {} : { files: invocation.prompt.files }),
        ...(invocation.prompt.agents === undefined ? {} : { agents: invocation.prompt.agents }),
        ...(invocation.prompt.skills === undefined ? {} : { skills: invocation.prompt.skills }),
        ...(invocation.prompt.metadata === undefined ? {} : { metadata: invocation.prompt.metadata }),
    };
}
export async function registerCommands(ctx, runtime) {
    const specs = new SpecService(runtime);
    const runs = new RunService(runtime);
    const roles = new RoleService(runtime);
    await ctx.command.transform((editor) => {
        editor.add({
            name: "ulw-plan",
            description: "Explore a request or existing spec and produce a frozen, reviewed implementation spec.",
            execute: async (invocation) => {
                const args = parseArgs(commandText(invocation), ["--spec", "--id"], ["--consult", "--strict"]);
                const sourceSpec = args.values.get("--spec");
                const requestedID = args.values.get("--id");
                const request = args.positionals.join(" ").trim();
                if (sourceSpec === undefined && request === "")
                    throw new UlwError("ARGS", "usage: /ulw-plan <request> or /ulw-plan --spec <path>");
                if (requestedID !== undefined && !isSpecSlug(requestedID))
                    throw new UlwError("ARGS", "--id must be a lowercase kebab-case slug");
                const session = await runtime.session(invocation.sessionID);
                const workspace = runtime.sessionWorkspace(session);
                if (!(await runtime.agentExists("ulw-plan")))
                    throw new UlwError("AGENT_PROFILE_MISSING", "ulw-plan profile is not installed; run oc2-ulw-plan init");
                await runtime.store(workspace).setPlan(invocation.sessionID, {
                    schema: "ulw-plan-session/v1",
                    strict: args.flags.has("--strict"),
                    ...(sourceSpec === undefined ? {} : { source: sourceSpec }),
                    createdAt: Date.now(),
                });
                await runtime.switchAgent(invocation.sessionID, "ulw-plan");
                let specInput = "";
                if (sourceSpec !== undefined) {
                    const absolute = join(workspace, sourceSpec);
                    if (!isWithin(workspace, absolute))
                        throw new UlwError("SOURCE_OUTSIDE", "spec source must stay inside the workspace");
                    const content = await readFile(absolute, "utf8").catch(() => {
                        throw new UlwError("SOURCE_MISSING", `spec source does not exist: ${sourceSpec}`);
                    });
                    specInput =
                        content.length <= 128 * 1024
                            ? `\nExisting source spec (${sourceSpec}), treat it as the scope input and do not modify it:\n\n${content}`
                            : `\nExisting source spec: ${sourceSpec}. Read it with the read tool; it is too large to inline. Do not modify it.`;
                }
                const skill = await runtime.readAsset("skills", "ulw-plan", "SKILL.md");
                const prompt = [
                    skill,
                    "",
                    "SPEC SCHEMA (authoritative; do not invent keys)",
                    SPEC_SCHEMA_GUIDE,
                    "",
                    "COMMAND",
                    sourceSpec === undefined ? "The user invoked /ulw-plan with a new request." : `The user invoked /ulw-plan --spec ${sourceSpec}.`,
                    requestedID === undefined ? "Choose and record a canonical spec id through ulw_spec action=begin." : `Use spec id: ${requestedID}`,
                    args.flags.has("--strict") ? "Strict review is required: use ulw_spec action=begin strict=true and require adversarial review." : "",
                    args.flags.has("--consult") ? "Run the consultant role once before practical review." : "",
                    "",
                    "REQUEST",
                    request || "(derived from the source spec)",
                    specInput,
                    "",
                    "Do not implement. Finish by publishing the reviewed spec and stopping with the handoff command.",
                ].filter(Boolean).join("\n");
                await ctx.session.prompt(promptRequest(invocation, prompt));
            },
        });
        editor.add({
            name: "ulw-review-budget",
            description: "Show review budget with --status, or explicitly authorize one extra plan-review attempt for the current spec hash. Never starts review or grants approval.",
            execute: async (invocation) => {
                const args = parseArgs(commandText(invocation), ["--role", "--reason"], ["--status"]);
                const specId = args.positionals[0];
                const role = args.values.get("--role");
                const reason = args.values.get("--reason");
                if (args.flags.has("--status") && args.positionals.length === 1 && specId !== undefined && isSpecSlug(specId) && role === undefined && reason === undefined) {
                    await specs.status(specId, invocation.sessionID);
                    const snapshot = await new DiagnoseService(runtime).report(invocation.sessionID, 20);
                    await ctx.session.synthetic({
                        sessionID: invocation.sessionID, text: snapshot.text,
                        metadata: { source: "ulw-review-budget", action: "status" }, resume: false,
                    });
                    return;
                }
                if (args.positionals.length !== 1 || specId === undefined || !isSpecSlug(specId) ||
                    args.flags.has("--status") || (role !== "practical-reviewer" && role !== "adversarial-reviewer") || reason === undefined) {
                    throw new UlwError("ARGS", 'usage: /ulw-review-budget <spec-id> --status OR --role practical-reviewer|adversarial-reviewer --reason "why one more attempt is authorized"');
                }
                const grant = await roles.grantPlanReviewAttempt(specId, role, reason, invocation.sessionID);
                await ctx.session.synthetic({
                    sessionID: invocation.sessionID,
                    text: `Review budget grant ${grant.id}: one extra ${grant.role} attempt for ${grant.specId} @ ${grant.targetHash}. Reason: ${grant.reason}. No review was started and no approval was changed.`,
                    metadata: { source: "ulw-review-budget", grantId: grant.id },
                    resume: false,
                });
            },
        });
        editor.add({
            name: "ulw-execute",
            description: "Authorize and execute a published ulw spec; --resume continues a paused run.",
            execute: async (invocation) => {
                const args = parseArgs(commandText(invocation), ["--resume", "--worktree"], ["--parallel", "--recover", "--takeover"]);
                const session = await runtime.session(invocation.sessionID);
                const canonical = runtime.sessionWorkspace(session);
                let resumeID = args.values.get("--resume");
                const specID = args.positionals[0];
                const worktreeRequest = args.values.get("--worktree");
                const takeover = args.flags.has("--takeover");
                if (resumeID === undefined && args.flags.has("--recover")) {
                    const allRuns = (await runtime.store(canonical).listRuns()).map((entry) => entry.value);
                    const candidates = [];
                    for (const run of allRuns) {
                        if (!["paused", "running", "final_verification"].includes(run.status))
                            continue;
                        if (specID !== undefined && run.specId !== specID)
                            continue;
                        if (run.ownerSessionID === invocation.sessionID) {
                            candidates.push(run);
                            continue;
                        }
                        const owner = await runtime.session(run.ownerSessionID).catch(() => undefined);
                        const busy = owner?.time?.busy !== undefined && (owner.time.idle === undefined || owner.time.busy > owner.time.idle);
                        if (owner === undefined || owner.outcome === "interrupted" || owner.outcome === "failed" || !busy)
                            candidates.push(run);
                    }
                    const latest = candidates.sort((left, right) => right.updatedAt - left.updatedAt)[0];
                    const own = candidates.filter((run) => run.ownerSessionID === invocation.sessionID);
                    const chosen = own.sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? latest;
                    if (chosen === undefined)
                        throw new UlwError("ARGS", "--recover found no paused or orphaned run for this workspace and spec");
                    if (chosen.ownerSessionID !== invocation.sessionID && !takeover) {
                        throw new UlwError("ARGS", `run ${chosen.id} belongs to session ${chosen.ownerSessionID}; rerun with --takeover to recover it`);
                    }
                    resumeID = chosen.id;
                }
                if (resumeID === undefined && (specID === undefined || !isSpecSlug(specID))) {
                    throw new UlwError("ARGS", "usage: /ulw-execute <spec-id> [--parallel] [--worktree auto|path] or /ulw-execute --recover [<spec-id>] [--takeover]");
                }
                if (resumeID !== undefined && worktreeRequest !== undefined) {
                    throw new UlwError("ARGS", "--worktree cannot be combined with --resume; the run already records its workspace");
                }
                const targetWorkspace = worktreeRequest === undefined ? canonical : await prepareWorktree(ctx, runtime, canonical, specID, worktreeRequest);
                if (!(await runtime.agentExists("ulw-exec")))
                    throw new UlwError("AGENT_PROFILE_MISSING", "ulw-exec profile is not installed; run oc2-ulw-plan init");
                const run = resumeID !== undefined
                    ? await runs.resume(resumeID, invocation.sessionID, undefined, takeover)
                    : await runs.start({
                        specId: specID,
                        sessionID: invocation.sessionID,
                        agent: "ulw-exec",
                        projectID: session.projectID ?? ctx.location.project.id,
                        workspace: targetWorkspace,
                        sessionWorkspace: canonical,
                    });
                try {
                    await runtime.switchAgent(invocation.sessionID, "ulw-exec");
                }
                catch (error) {
                    await runs.pause(run.id, invocation.sessionID, "agent switch failed").catch(() => undefined);
                    throw error;
                }
                const status = await runs.status(run.id, invocation.sessionID);
                const skill = await runtime.readAsset("skills", "ulw-execute", "SKILL.md");
                const prompt = [
                    skill,
                    "",
                    "AUTHORIZED RUN",
                    status.text,
                    "",
                    `Parallel implementation workers: ${args.flags.has("--parallel") ? "allowed only for independent non-overlapping tasks." : "not requested; implement directly."}`,
                    args.values.has("--worktree") ? `Worktree request: ${args.values.get("--worktree")}. The execution adapter must validate it before any edit.` : "Workspace: current checkout.",
                    "",
                    "Execute the authorized spec now. Do not create a new run, do not edit the spec, and do not claim success before freeze, independent verification, code review and finalize.",
                ].join("\n");
                await ctx.session.prompt(promptRequest(invocation, prompt));
            },
        });
        editor.add({
            name: "ulw-status",
            description: "Show the Host-computed ulw spec/run status. Add --diagnose for specs, runs, roles, the lock and recent failures.",
            execute: async (invocation) => {
                const raw = commandText(invocation);
                const tokens = raw.split(/\s+/).filter(Boolean);
                const diagnose = tokens.includes("--diagnose");
                const target = tokens.find((token) => !token.startsWith("--")) ?? "";
                const session = await runtime.session(invocation.sessionID);
                const workspace = runtime.sessionWorkspace(session);
                const store = runtime.store(workspace);
                let text;
                if (target !== "" && target.startsWith("run-")) {
                    text = (await runs.status(target, invocation.sessionID)).text;
                }
                else {
                    const active = await runs.findActiveRun(workspace, invocation.sessionID);
                    const sessionRun = active ?? (await runs.findSessionRun(workspace, invocation.sessionID));
                    if (sessionRun !== undefined) {
                        text = (await runs.status(sessionRun.id, invocation.sessionID)).text;
                    }
                    else if (target !== "") {
                        const record = await specs.status(target, invocation.sessionID);
                        text = [
                            `# ulw spec ${record.id}`,
                            `status: ${record.status}`,
                            `risk: ${record.risk}`,
                            `strict: ${record.strict === true ? "yes" : "no"}`,
                            `hash: ${record.contentHash}`,
                            `practical: ${record.practical?.verdict ?? "none"}`,
                            `adversarial: ${record.adversarial?.verdict ?? "none"}`,
                            `next: ${record.status === "ready" ? `/ulw-execute ${record.id}` : "finish validation and independent review, then ulw_spec action=publish"}`,
                        ].join("\n");
                    }
                    else {
                        const list = await specs.list(invocation.sessionID);
                        const runList = (await store.listRuns()).map((entry) => entry.value);
                        text = [
                            "# ulw status",
                            "",
                            "## Specs",
                            ...(list.length === 0 ? ["- none"] : list.map((entry) => `- ${entry.id}: ${entry.status} (${entry.risk}) [${entry.kind}]`)),
                            "",
                            "## Runs",
                            ...(runList.length === 0 ? ["- none"] : runList.map((entry) => `- ${entry.id}: ${entry.status} (${entry.specId})`)),
                        ].join("\n");
                    }
                }
                if (diagnose) {
                    const snapshot = await new DiagnoseService(runtime).report(invocation.sessionID, 20);
                    text = [text, "", snapshot.text].join("\n");
                }
                const prompt = [
                    "The Host computed the following ulw status. Present it to the user faithfully; do not invent or upgrade any state.",
                    "",
                    text,
                ].join("\n");
                await ctx.session.prompt(promptRequest(invocation, prompt));
            },
        });
    });
}
//# sourceMappingURL=commands.js.map
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeContext } from "../helpers/fake-context.js";
import { Runtime } from "../../src/opencode/runtime.js";
import { SpecService } from "../../src/opencode/spec-service.js";
import { RoleService } from "../../src/opencode/roles.js";
import { analyzeSpec } from "../../src/core/spec.js";
import type { RoleInvocation } from "../../src/core/types.js";
import type { SessionInfo } from "../../src/opencode/session.js";

const VALID = `---
schema: ulw-spec/v1
id: authoring-sample
title: Authoring sample
requirements:
  - id: R1
    text: The sample behavior is implemented and tested.
nonGoals:
  - No unrelated refactoring.
tasks:
  - id: T1
    title: Implement the sample behavior and its test
    requirements: [R1]
    dependsOn: []
    files: [src/sample.ts, test/sample.test.ts]
    checks: [V1]
checks:
  - id: V1
    type: command
    description: Run the sample test
    argv: [node, --test, test/sample.test.ts]
    cwd: .
    expect:
      exitCode: 0
review:
  risk: low
  requireAdversarial: false
---

## Design

The sample behavior is implemented in the named source file and verified by the focused test. The scope stays deliberately narrow.
`;

test("analyzeSpec reports every structural error with allowed keys and id formats", () => {
  const invalid = VALID.replace("    files: [src/sample.ts, test/sample.test.ts]", "    files: [src/sample.ts]\n    acceptance: true").replace("  - id: V1", "  - id: C1");
  const analysis = analyzeSpec(invalid);
  assert.equal(analysis.parsed, undefined);
  const messages = analysis.diagnostics.map((entry) => entry.message).join("\n");
  assert.match(messages, /tasks\[0\]: unknown key "acceptance" \(allowed: id, title, requirements, dependsOn, files, checks\)/);
  assert.match(messages, /checks\[0\]\.id must match V<number> \(for example V1\): C1/);
  assert.ok(analysis.diagnostics.length >= 2);
});

test("write persists invalid content and patch repairs it without a full rewrite", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "oc2-ulw-authoring-"));
  const fake = createFakeContext({ workspace });
  const session = await fake.ctx.session.create({ title: "plan", agent: "ulw-plan", location: { directory: workspace } });
  const runtime = new Runtime(fake.ctx);
  const specs = new SpecService(runtime);
  await specs.begin({ id: "authoring-sample", request: "Exercise authoring", strict: false }, session.id);

  const invalid = VALID.replace("    files: [src/sample.ts, test/sample.test.ts]", "    files: [src/sample.ts]\n    acceptance: true").replace("  - id: V1", "  - id: C1");
  const first = await specs.write({ id: "authoring-sample", content: invalid }, session.id);
  assert.equal(first.valid, false);
  const stored = await readFile(join(workspace, ".opencode", "ulw", "specs", "authoring-sample.md"), "utf8");
  assert.match(stored, /acceptance: true/);

  const repaired = await specs.patch(
    {
      id: "authoring-sample",
      edits: [
        { old: "\n    acceptance: true", new: "" },
        { old: "C1", new: "V1", replaceAll: true },
      ],
    },
    session.id,
  );
  assert.equal(repaired.valid, true, JSON.stringify(repaired.diagnostics));
  const final = await readFile(join(workspace, ".opencode", "ulw", "specs", "authoring-sample.md"), "utf8");
  assert.doesNotMatch(final, /acceptance/);
  assert.match(final, /id: V1/);
});

test("list exposes drafts and strict validation reaches the record", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "oc2-ulw-authoring-"));
  const fake = createFakeContext({ workspace });
  const session = await fake.ctx.session.create({ title: "plan", agent: "ulw-plan", location: { directory: workspace } });
  const runtime = new Runtime(fake.ctx);
  const specs = new SpecService(runtime);
  await specs.begin({ id: "strict-sample", request: "Strict sample", strict: true }, session.id);
  const listed = await specs.list(session.id);
  assert.deepEqual(
    listed.map((entry) => [entry.id, entry.kind, entry.status]),
    [["strict-sample", "draft", "draft"]],
  );
  const result = await specs.write({ id: "strict-sample", content: VALID.replace("id: authoring-sample", "id: strict-sample").replace("nonGoals:\n  - No unrelated refactoring.\n", "") }, session.id);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((entry) => entry.code === "NON_GOALS_EMPTY"));
});

test("explorer can start from a draft before an executable spec exists", { timeout: 10_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "oc2-ulw-authoring-"));
  const fake = createFakeContext({ workspace });
  (fake.ctx as unknown as { options: Record<string, unknown> }).options = { roleTimeoutMs: 3000 };
  const session = await fake.ctx.session.create({ title: "plan", agent: "ulw-plan", location: { directory: workspace } });
  const runtime = new Runtime(fake.ctx);
  const specs = new SpecService(runtime);
  await specs.begin({ id: "draft-target", request: "Research this draft", strict: false }, session.id);

  const prompt = fake.ctx.session.prompt as unknown as (input: { sessionID: string }) => Promise<void>;
  (fake.ctx.session as unknown as { prompt: (input: { sessionID: string }) => Promise<void> }).prompt = async (input) => {
    await prompt(input);
    setTimeout(() => {
      const child = fake.sessions.get(input.sessionID) as SessionInfo | undefined;
      if (child !== undefined) {
        child.outcome = "succeeded";
        child.time = { ...child.time, busy: Date.now(), idle: Date.now() + 1 };
      }
    }, 50);
  };

  const roles = new RoleService(runtime);
  const result = await roles.start(
    { role: "explorer", specId: "draft-target", assignment: "Inspect the draft intent.", background: false },
    { sessionID: session.id, agent: "ulw-plan" },
  );
  assert.equal(result.status, "failed");
  assert.match(result.summary, /without a report/);
  const invocations = (await runtime.store(workspace).listInvocations<RoleInvocation>()).map((entry) => entry.value);
  const explorer = invocations.find((entry) => entry.role === "explorer");
  assert.ok(explorer !== undefined);
  assert.equal(explorer.specId, "draft-target");
  assert.equal(explorer.targetHash?.length, 64);
});

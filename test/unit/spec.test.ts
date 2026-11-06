import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpec, lintSpec, effectiveRisk } from "../../src/core/spec.js";
import { topologicalWaves } from "../../src/core/graph.js";

const VALID = `---
schema: ulw-spec/v1
id: sample-feature
title: Sample feature
sources:
  - path: docs/request.md
requirements:
  - id: R1
    text: The sample feature returns the expected value.
nonGoals:
  - No unrelated refactor.
tasks:
  - id: T1
    title: Implement the sample feature and its test
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

The sample feature is implemented in src/sample.ts and verified by the sample test. The implementation stays inside the named files.
`;

test("parseSpec parses a complete executable spec", () => {
  const parsed = parseSpec(VALID);
  assert.equal(parsed.spec.id, "sample-feature");
  assert.equal(parsed.spec.requirements[0]?.id, "R1");
  assert.equal(parsed.spec.tasks[0]?.files.length, 2);
  assert.equal(parsed.spec.checks[0]?.type, "command");
  assert.match(parsed.body, /## Design/);
  assert.equal(parsed.sha256.length, 64);
});

test("lintSpec accepts the canonical sample", () => {
  const parsed = parseSpec(VALID);
  const diagnostics = lintSpec(parsed, false);
  assert.deepEqual(diagnostics.filter((entry) => entry.severity === "error"), []);
});

test("unknown YAML keys are rejected", () => {
  const invalid = VALID.replace("  risk: low", "  risk: low\n  surprise: true");
  assert.throws(() => parseSpec(invalid), /unknown key/);
});

test("duplicate requirement ids are rejected", () => {
  const invalid = VALID.replace("  - id: R1\n    text: The sample feature returns the expected value.", "  - id: R1\n    text: The sample feature returns the expected value.\n  - id: R1\n    text: Another requirement.");
  const parsed = parseSpec(invalid);
  assert.ok(lintSpec(parsed, false).some((entry) => entry.code === "REQUIREMENT_DUPLICATE"));
});

test("an uncovered requirement is rejected", () => {
  const invalid = VALID.replace("    requirements: [R1]", "    requirements: []").replace("  - id: R1\n    text: The sample feature returns the expected value.", "  - id: R1\n    text: The sample feature returns the expected value.\n  - id: R2\n    text: A second requirement.");
  const parsed = parseSpec(invalid);
  assert.ok(lintSpec(parsed, false).some((entry) => entry.code === "REQUIREMENT_UNCOVERED"));
});

test("a task dependency cycle is rejected", () => {
  const invalid = VALID.replace("    dependsOn: []", "    dependsOn: [T2]").replace("  - id: T1", "  - id: T2\n    title: Second task\n    requirements: [R1]\n    dependsOn: [T1]\n    files: [src/other.ts]\n    checks: [V1]\n  - id: T1");
  const parsed = parseSpec(invalid);
  assert.ok(lintSpec(parsed, false).some((entry) => entry.code === "TASK_CYCLE"));
});

test("placeholders are rejected", () => {
  const invalid = VALID.replace("Implement the sample feature and its test", "Implement <fill this in>");
  const parsed = parseSpec(invalid);
  assert.ok(lintSpec(parsed, false).some((entry) => entry.code === "PLACEHOLDER"));
});

test("high risk paths require adversarial review", () => {
  const parsed = parseSpec(VALID.replace("files: [src/sample.ts, test/sample.test.ts]", "files: [src/auth/session.ts]"));
  assert.equal(effectiveRisk(parsed.spec, parsed.body), "high");
});

test("topological waves honor dependencies", () => {
  const parsed = parseSpec(
    VALID.replace("    dependsOn: []", "    dependsOn: [T2]").replace("  - id: T1", "  - id: T2\n    title: Second task\n    requirements: [R1]\n    dependsOn: []\n    files: [src/other.ts]\n    checks: [V1]\n  - id: T1"),
  );
  assert.deepEqual(topologicalWaves(parsed.spec.tasks), [["T2"], ["T1"]]);
});

test("frontmatter and body are both required", () => {
  assert.throws(() => parseSpec("no frontmatter"), /frontmatter/);
  assert.throws(() => parseSpec(VALID.slice(0, VALID.indexOf("---", 4) + 3)), /body/);
});

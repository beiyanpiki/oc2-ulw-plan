import { test } from "node:test";
import assert from "node:assert/strict";

// Real-model smoke testing is intentionally opt-in. It spends provider tokens
// and must be run against a project where the user has reviewed the spec.
test(
  "real-model smoke is opt-in",
  { skip: process.env.OC2_ULW_SMOKE !== "1" },
  async () => {
    const project = process.env.OC2_ULW_SMOKE_PROJECT;
    assert.ok(project, "set OC2_ULW_SMOKE_PROJECT to the target project");
    // The operator runs the documented manual flow:
    //   /ulw-plan <small request>
    //   /ulw-execute <spec-id>
    // and records the resulting run id, report path and verification verdicts.
    assert.ok(project.length > 0);
  },
);

# oc2-ulw-plan

A lightweight **Plan → Spec → Execute** workflow for OpenCode V2.

It keeps the useful discipline of explore → plan → execute — explore first, freeze one
executable spec, require independent plan review, record real evidence, and
verify the landed product — while remaining a small OpenCode V2 plugin.

Verified against **OpenCode 2.2.5** on Linux. The package is not affiliated with
OpenCode or with oh-my-openagent.

## What it gives you

- `/ulw-plan <request>` — explore a repository and produce one frozen,
  executable spec.
- `/ulw-plan --spec <path>` — turn an existing spec into an executable plan
  without modifying the source file.
- `/ulw-execute <spec-id>` — authorize and execute a published spec.
- `/ulw-execute --resume <run-id>` — resume a paused run after checking the
  workspace and lock.
- `/ulw-execute --recover [<spec-id>] --takeover` — take over a paused or
  orphaned run whose owner session is idle or interrupted.
- `/ulw-status [spec-id|run-id] [--diagnose]` — show Host-computed state,
  evidence, roles, the next action and recent failures.
- `oc2-ulw-plan diagnose --project <dir>` — validate every spec on disk and
  print the lock, artifacts and recent diagnostics.
- Optional `--strict`, `--consult`, `--parallel` and `--worktree auto|path`.

The spec is a contract, the run is mutable state, and evidence is recorded
separately. A model cannot approve a plan or mark a run successful by writing
text.

## Install

### From npm

The published package installs the same plugin, agent profiles and CLI. It is
the option to use when OpenCode cannot resolve a Git/GitHub package specifier.

```bash
npm install -g oc2-ulw-plan
oc2-ulw-plan init --global --plugin oc2-ulw-plan
```

Project-local:

```bash
npm install -D oc2-ulw-plan
npx oc2-ulw-plan init --project /path/to/project --plugin oc2-ulw-plan
```

If OpenCode cannot resolve the bare package name in your setup, pass the
installed path instead:

```bash
oc2-ulw-plan init --global --plugin "$(npm root -g)/oc2-ulw-plan"
```

### From a GitHub release

The release installer downloads the packaged tarball, installs it outside the
project, writes the five agent profiles and merges the plugin path into the
OpenCode configuration:

```bash
curl -fsSL https://raw.githubusercontent.com/beiyanpiki/oc2-ulw-plan/main/scripts/install-release.sh | bash
```

Install into one project instead:

```bash
curl -fsSL https://raw.githubusercontent.com/beiyanpiki/oc2-ulw-plan/main/scripts/install-release.sh | bash -s -- --project /path/to/project
```

Or run the script from a checkout:

```bash
./scripts/install-release.sh --version v0.2.0 --global
```

### From a checkout

```bash
npm install
npm run build
node dist/cli.js init --project /path/to/project --plugin /absolute/path/to/oc2-ulw-plan
```

`init`:

- installs five agent profiles under `.opencode/agents/` (or the global
  `~/.config/opencode/agents/`);
- merges the plugin entry into `.opencode/opencode.jsonc` without dropping
  comments or unrelated settings;
- refuses to overwrite a different user-owned profile;
- records what it owns in a manifest so `uninstall` cannot remove user files.

```bash
node dist/cli.js doctor --project /path/to/project --plugin oc2-ulw-plan
node dist/cli.js diagnose --project /path/to/project
node dist/cli.js uninstall --project /path/to/project
```

`uninstall` removes only profiles and plugin entries recorded as package-owned,
and preserves specs, runs, evidence and reports.

After a planning or execution session, switch back to **Build** (or another
ordinary agent) for unrelated edits. `ulw-plan` and `ulw-exec` are intentionally
narrow profiles; `ulw-exec` rejects product side effects when no active run
exists.

## Agent profiles

| Profile | Used by |
|---|---|
| `ulw-plan` | Planner; read-only product files, writes specs through `ulw_spec` |
| `ulw-exec` | Executor; product writes only inside an active run |
| `ulw-readonly` | Explorer, librarian, consultant, practical/adversarial reviewer, code reviewer |
| `ulw-verifier` | Independent verifier; can run frozen checks |
| `ulw-worker` | Optional scoped implementation worker |

Profiles are installed as normal OpenCode agent files, not created dynamically
by the plugin. Worktree execution requires the profiles to be visible from the
worktree: install globally, or keep `.opencode/agents/` committed.

## Roles and budgets

- **Planner** explores, writes the spec, obtains D, and stops.
- **A Explorer** — code facts, two invocations per spec. It may target a draft
  before an executable spec exists, or run with only an `assignment`.
- **Executor** implements directly by default. `--parallel` allows scoped F
  workers for independent, non-overlapping tasks.
- **B Librarian** — external facts and primary sources, two per spec.
- **C Consultant** — one pre-planning gap analysis per spec.
- **D Practical Reviewer** — required for every published spec, two rounds.
- **E Adversarial Reviewer** — required for high-risk specs, `--strict`, or
  when D escalates; two rounds.
- **G Independent Verifier** — required for success, two rounds per run.
- **H Code Reviewer** — required for success, two rounds per run.

D/E/G/H run in fresh child sessions. Their reports are bound by the Host to the
invocation, child session and target digest; a caller cannot pass arbitrary
approval fields. A worker report is a completion claim, never approval.

## Spec format

Create `.opencode/ulw/specs/<id>.md` through `ulw_spec action=write`. Call
`ulw_spec action=template` for the complete key reference and a valid example;
`ulw_spec action=begin` prints the same reference automatically.

`write` validates the whole file before it is usable but still **saves** the
content when it is invalid. The response lists every structural error, so a
planner can repair the file with `ulw_spec action=patch` (`edits: [{old, new}]`)
instead of regenerating a large document after the first mistake. Invalid files
stay in `draft` status and can never be published or executed. For a large spec,
start from a small valid skeleton and grow it with `action=patch`.

A minimal spec looks like this:

```markdown
---
schema: ulw-spec/v1
id: add-login-rate-limit
title: Add a per-IP login rate limit
requirements:
  - id: R1
    text: More than five failed login attempts per minute returns 429.
  - id: R2
    text: A legitimate user is never locked out by another IP.
nonGoals:
  - No account-level lockout.
tasks:
  - id: T1
    title: Implement the limiter and its tests
    requirements: [R1, R2]
    dependsOn: []
    files: [src/auth/login.ts, test/auth/login.test.ts]
    checks: [V1, V2]
checks:
  - id: V1
    type: command
    description: Run the auth tests
    argv: [npm, test, --, test/auth/login.test.ts]
    cwd: .
    timeoutMs: 120000
    expect:
      exitCode: 0
  - id: V2
    type: procedure
    description: Exercise the real HTTP surface
    steps:
      - Start the app with the test configuration
      - Send six failed requests for one IP
      - Send one request for another IP
    expected: The sixth same-IP request returns 429 and the other IP succeeds
    requiredTools: [curl]
review:
  risk: medium
  requireAdversarial: false
---

## Design

The limiter is enforced in the existing auth middleware. Storage and failure
responses reuse the existing request path. No account-level state is added.
```

Validation rules include:

- canonical `R`, `T`, `V` ids and unique keys;
- every requirement covered by a task;
- every task has dependencies, exact file scope and checks;
- every check used by a task;
- no dependency cycle, placeholder or unknown field;
- source files must exist and match their recorded hash;
- task paths cannot escape the workspace or target secrets/`.git`.

The whole spec file hash is the version. Published specs are frozen; use
`ulw_spec action=reopen` before revising. A revised spec needs fresh D/E
approvals.

## Diagnostics

Every failed `ulw_*` tool call and every invalid spec write is appended to
`.opencode/ulw/diagnostics.jsonl` (rotated at 512 KiB). Entries record the
session, agent, tool, action, error code and a short message, never the spec
content.

- `/ulw-status --diagnose` prints the latest entries next to Host state.
- `ulw_diagnose` returns a read-only Host snapshot of specs, runs, role
  invocations, the workspace lock and recent failures.
- `oc2-ulw-plan diagnose --project <dir>` validates every spec on disk, reports
  drafts, inspects the workspace lock and prints recent diagnostics.
- `ulw_run` status shows the owner session and warns when a running run is
  orphaned (owner idle, interrupted or missing).
- `/ulw-execute --recover <spec-id> --takeover` transfers the lock and run
  ownership when the previous owner is idle or interrupted.

## Execution guarantees

Before a run starts:

- the spec must be `ready` and both required reviews must be real bound reports;
- source hashes and task paths are rechecked;
- the workspace must be a Git worktree;
- uncommitted user changes overlapping task files block the run;
- a workspace lock prevents a second writer;
- the baseline (including dirty-file snapshots) is recorded.

During a run:

- `ulw_check` runs only frozen command checks, with a fixed `argv`, cwd,
  timeout, cancellation and output cap;
- evidence records the real exit code, output and code fingerprint;
- a check after which product files changed is stale and cannot pass;
- a task can only be checked with passing evidence at the current code version;
- a repeated failure signature stops the task after two attempts, and attempts
  are capped at three.

After implementation:

- `freeze` records the exact code fingerprint and writes a diff artifact;
- G rechecks requirement coverage and runs procedure checks;
- H reviews the actual diff in a fresh read-only session;
- only G and H approvals for the same frozen fingerprint plus a final report can
  produce `succeeded`;
- missing tools, cancellation, timeouts, stale code and incomplete reports are
  never success.

`paused`, `blocked`, `stale` and `failed` are distinct from `succeeded`.

## Worktree mode

`--worktree auto` calls the native OpenCode worktree API. `--worktree <path>`
accepts an existing worktree of the same Git repository. The frozen spec and its
record are copied into the worktree artifact root. One run uses one worktree;
the plugin does not merge, push or delete it automatically.

Auto worktree mode expects a clean product baseline. The package never copies
uncommitted user product changes into a new worktree.

## Security boundary

This is a workflow guard, not an operating-system sandbox.

- Plan and read-only profiles deny direct edits and shell.
- The executor may use shell while a run is active; shell commands have the
  host user's authority and can modify files outside the declared task scope.
  Use an OS sandbox if you need hard containment.
- `ulw_check` executes commands authored in the frozen spec after the user ran
  `/ulw-execute`. Review the spec before authorizing it.
- `--worktree` and external directories are not security boundaries by
  themselves.
- The plugin never automatically commits, pushes, opens a PR or merges.

## Development

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run test:host
npm run build
npm pack --dry-run
npm run verify
```

`test:host` starts an isolated OpenCode 2 server with temporary HOME/XDG
directories and checks command, agent, skill and plugin discovery. It does not
call a model.

`test:smoke` is reserved for real-model smoke tests and is not part of the
default verification because it needs a configured provider and can spend money.

## Releases and CI

- `.github/workflows/ci.yml` runs lint, unit/integration tests and the build on
  pushes to `main` and on pull requests.
- `.github/workflows/release.yml` runs on `v*` tags. It re-runs the checks,
  builds `npm pack`, creates or updates the GitHub release with the tarball and
  `scripts/install-release.sh`, and publishes the tarball to npm with
  **Trusted Publishing (OIDC)**. No long-lived npm token is stored in CI.
- Configure the npm trusted publisher once on npmjs.com:
  - provider: GitHub Actions
  - organization/user: `beiyanpiki`
  - repository: `oc2-ulw-plan`
  - workflow filename: `release.yml`
  - allowed actions: `npm publish`
- A newly created trusted publisher must complete its first publish within two
  days. After the first publish, the configuration is validated and bound to the
  repository's immutable identity.
- Recommended after the first publish: package Settings → Publishing access →
  require 2FA and disallow token publishing.
- To cut a release: update `package.json`, commit, then
  `git tag vX.Y.Z && git push origin main --tags`. The tag must match the
  package version; the workflow refuses a mismatch.

## Known limits

- The host integration is verified on OpenCode 2.2.5/Linux; older versions may
  not have the same plugin contract.
- OpenCode 2.2.5's `opencode plugin add` can fail for Git package specifiers
  because its bundled npm cannot prepare Git dependencies. Install from the npm
  registry (`npm install -g oc2-ulw-plan`) or use the release installer, which
  writes an explicit local plugin path.
- Procedure checks require a capable verifier and a real surface. Missing tools
  make the run `inconclusive`, not successful.
- The current worktree flow requires profiles to be discoverable from the
  worktree (global installation or committed `.opencode/agents`).
- The plugin does not provide a general DAG scheduler, team messaging, or
  exactly-once recovery for arbitrary external side effects.
- Full real-model Plan → Execute → G/H smoke testing is an explicit operator
  step, not something `npm test` starts silently.

## Attribution

The workflow was inspired by the explore → plan → execute ideas of
`oh-my-openagent`. This repository is an independent OpenCode V2
implementation.

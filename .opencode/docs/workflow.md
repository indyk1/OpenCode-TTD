# How the workflow runs

What happens, step by step, when you ask for a feature or report a bug - and how the platform the app runs on is decided. For what to type and how to answer the pop-ups, see [GUIDE.md](../../GUIDE.md).

## How a feature runs

1. **Plan.** senior-dev writes the OpenSpec change: proposal, specs (one requirement per slice, GIVEN/WHEN/THEN scenarios), design (slice map, contracts, shared-knowledge and platform questions), test plan, tasks. If the change needs a platform resource that is decided but not built (say, the database), the platform agent adds it to the AppHost first.
   **Checkpoint 1** - you answer its questions and approve the plan. *Signature: allowing test-writer to start.*
2. **Red.** test-writer writes one acceptance test per scenario and proves each fails for the predicted reason. test-reviewer checks every test against the scenarios - a different model from the writer - and the writer fixes what it finds.
   **Checkpoint 2** - you approve the tests from the reviewer's plain-English summary. *Signature: allowing `scripts/lock-tests.sh`.*
3. **Green.** developer implements slice by slice and cannot touch the locked tests.
4. **Verify.** senior-dev runs `scripts/verify.sh` (build, every test, lock, scenario coverage, architecture rules) and reviews the diff.
   **Checkpoint 3** - you accept the result. *Signature: allowing `scripts/finish-change.sh`, which archives the change into the living specs and commits.*

## How a bug runs

Bugs stay in OpenSpec - the regression test needs a scenario to trace to, and the behaviour the bug exposed belongs in the living spec - but on a lighter track: the `vsa-tdd-bugfix` schema (investigation → spec delta → test plan → tasks) with two checkpoints instead of three.

1. **Investigate.** `/bug <what you did, what happened, what you expected>` → senior-dev opens a `fix-…` change and sends the debugger. It starts the app with `aspire start`, reproduces the bug in a headless browser (signing in with its own local test account if needed), reads the Aspire logs and traces, maps the failure to its slice and writes `investigation.md`: plain-English explanation, evidence, root cause, proposed fix, the scenario that would have caught it, and a classification. It never edits code.
2. **Route by classification.**
   - `spec-broken` (the code breaks what the spec says) or `spec-silent` (the spec missed the case): the bug track.
   - `technical` (performance, configuration, a flaky test, a vulnerable package): the bug track without a spec change (`skip_specs`); the test plan says how the fix is proven.
   - `as-specified` (the app does what was agreed): not a bug. You are asked whether to change it; if so, the same change switches to the feature schema, keeping the investigation.
   - A fix that needs a shared-rule or platform decision also switches to the feature track.
   - `not-reproduced`: you are asked for what the debugger needs.
3. **Reproduce in a test.** test-writer writes the regression test, which must fail *because of the bug*; test-reviewer checks it.
   **Checkpoint A** - you approve the diagnosis and its proof together. *Signature: `scripts/lock-tests.sh`.*
4. **Fix and verify.** developer fixes the root cause; senior-dev verifies.
   **Checkpoint B** - you accept it. *Signature: `scripts/finish-change.sh`.* The new scenario joins the living spec, so the bug cannot quietly come back.

Broken in production? Roll back to the last good version first (a technical step), then fix it through `/bug`.

## Platform decisions and Aspire

`/setup` asks a few plain-English questions - where it will run, whether it stores data, sign-in, live updates, access for other systems or AI assistants - and records the answers in `openspec/decisions/platform.md`. Every agent follows them; anything not covered is asked before it is built, so no technology is picked by default. Capabilities are built by the first change that needs them, with tests.

Everything runs on .NET Aspire: the AppHost describes the app and its resources, `aspire start` runs them locally with a dashboard, and `/deploy` uses `aspire deploy` (Azure Container Apps) or `aspire publish` (Docker Compose or Kubernetes for your own server or AWS). Acceptance tests deliberately do not use Aspire's test host - it runs the app out of process, so substitutes cannot be injected - and use `WebApplicationFactory` with throwaway containers for real dependencies instead.

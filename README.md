# Vertical slices, test-first: an opencode workflow for .NET and Aspire

A team of AI agents builds a .NET application with you. You describe what you want in plain English; they plan it, write the tests first, build it as vertical slices, check it, and save it - coming back to you at three checkpoints. Nothing moves past a checkpoint without your approval, and you never need to read code to give it.

**Driving it day to day? Read [GUIDE.md](GUIDE.md).** This README is the technical reference.

| Agent | Model | Effort | Does | Can edit |
|---|---|---|---|---|
| **senior-dev** (primary) | Claude Opus 5.5 | high | Plans with OpenSpec, asks you business and platform questions in plain English, writes the test plan, delegates, verifies, saves | `openspec/` only |
| **test-writer** | Claude Sonnet 5.5 | high | Turns the test plan into failing acceptance tests and empty slice contracts | acceptance tests, `*.Contracts.cs` |
| **test-reviewer** | Claude Opus 5.5 | high | Checks the tests independently and describes each in plain English | nothing |
| **developer** | Claude Sonnet 5.5 | medium | Implements one slice at a time until its locked tests pass, with its own unit tests | `src/` except contracts and the Aspire projects; unit tests |
| **platform** (primary + subagent) | Claude Sonnet 5.5 | high | `/setup`, Aspire resources such as a database, `/deploy` | the Aspire projects, app wiring and test infrastructure, platform decisions |
| **debugger** | Claude Opus 5.5 | high | Reproduces a bug locally in a browser, reads logs, traces and code, explains the cause and fix | its investigation file only |

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

## Setup

Prerequisites:
- .NET SDK 10 or later (it includes `dnx`, which downloads Roslynk the first time opencode starts in the project)
- [Aspire CLI](https://aspire.dev/get-started/install-cli/)
- Node.js 20+
- git, with `user.name` and `user.email` set
- [opencode](https://opencode.ai)
- Podman (free) or Docker, for databases and other resources. Docker Desktop needs a paid subscription in larger organisations.
- Google Chrome, for the debugger's browser
- bash: on Windows, run everything in WSL

Then:
1. `npm install -g @fission-ai/openspec@latest`
2. Copy this template into the root of your repository. It adds only `.opencode/`, `opencode.json`, `AGENTS.md`, `GUIDE.md`, `openspec/`, `scripts/` and `.workflow/`.
3. `opencode models anthropic` should list `claude-opus-5-5` and `claude-sonnet-5-5`. If not, update opencode; for another provider, change the `model:` lines in `.opencode/agents/*.md`.
4. New application: run `opencode` and `/setup <Title> - <what it does>`. Existing solution: see below.
5. Commit.

Do not run `openspec init --tools opencode` or `aspire agent init`: they add generic commands, skills and MCP configuration that bypass this workflow's checkpoints and permissions. The template already configures what it needs.

### Existing solution
Bring it to .NET 10 and add Aspire (`dotnet new install Aspire.ProjectTemplates`, then `aspire-apphost` and `aspire-servicedefaults` projects named `<App>.AppHost` and `<App>.ServiceDefaults`). Make sure `tests/<App>.AcceptanceTests` (NUnit, `Microsoft.AspNetCore.Mvc.Testing`, `NSubstitute`) and `tests/<App>.UnitTests` (NUnit, `NSubstitute`) exist. Recommended: the architecture tests from `.opencode/skills/vertical-slices/references/architecture-tests.md`. Describe the application in `openspec/config.yaml` (`  Application: <Title> - <what it does>` as the first line of the `context` block), write your platform decisions in `openspec/decisions/platform.md`, and lock any existing acceptance tests: `scripts/lock-tests.sh initial`.

## The debugger, safely
- It runs a **local** copy only. The browser is a headless Playwright MCP server limited to `localhost` (`--allowed-origins`). Playwright documents origin filtering as a guard rail rather than a security boundary, so never point the debugger at a real environment.
- Its credentials live in `.workflow/debugger.env`, which git ignores. The browser server receives the file as its secrets file and masks those values in everything it returns to the agent. If the agent ever needs to read the file itself, you are asked first. Use a local-only test account - never a real one.
- The browser and Aspire MCP tools are denied to every agent except the debugger.

## Roslynk, read-only
[Roslynk](https://github.com/mrpmorris/Roslynk) (MIT) gives the developer and the debugger a live Roslyn compilation of the solution: go to definition, find references and callers, read a single member, and compile errors near-instantly instead of after a full `dotnet build`. `opencode.json` pins Roslynk 2.0.0 and starts it through `dnx`, so there is nothing to install.
- **Read-only.** `opencode.json` denies every `roslynk_*` tool; `developer.md` and `debugger.md` allow its 20 read-only tools by name. Its 8 editing tools (`apply_patch`, `rename_symbol`, `rename_parameter`, `change_signature`, `extract_method`, `remove_unused_usings`, `apply_code_action`, `apply_code_fix`) write straight to disk and could reach the tests, the lock and the workflow files, so no agent gets them. Edits still go through each agent's own edit permissions.
- **A shared background process.** opencode starts Roslynk with every session in the project - only the developer and the debugger can use its tools - and the first start launches a daemon on `localhost:6502` (loopback only, no sign-in) that later sessions share. It unloads a solution after 30 idle minutes but keeps running after opencode exits. Its log is `~/.local/share/Roslynk/daemon.log`; stop it with `pkill -f Morris.Roslynk.Mcp`.
- **Kept off the daemon's port.** The daemon accepts any local connection, including calls to its editing tools, so `debugger.md` denies `curl *:6502*` and the browser server blocks `http://localhost:6502` (`--blocked-origins`). Like the bash rules, this is a guard rail, not a sandbox.
- **Port 6502 taken?** Give the `roslynk` entry in `opencode.json` its own port: `"environment": { "Roslynk__Port": "6517" }`, and change `6502` to match in the debugger's `curl *:6502*` rule and in the browser server's `--blocked-origins`.
- **Not available?** The agents carry on with their usual tools and say so in their report.

## Commands
- `/setup <Title> - <what it does>` - create a new application (once)
- `/feature <what you want>` - a change
- `/bug <what happened>` - investigate and fix a bug
- `/deploy` - put it online or update it
- `/resume <change-name>` - carry on; state lives in `openspec/changes/<name>/status.md`

## What is enforced, and how

| Rule | Mechanism |
|---|---|
| senior-dev never writes code | its edit permission covers `openspec/` only |
| Tests are approved before implementation | starting test-writer and running the lock script both need your permission; the developer refuses to start without a valid lock |
| The developer cannot change the tests | edits denied on acceptance tests and contracts; the SHA-256 lock is checked before and after implementation |
| Tests are checked by someone other than their author | test-reviewer (a different model) reviews before checkpoint 2 / A |
| A bug fix proves the bug first | the regression test must fail with the bug itself before the fix; reviewer checks it |
| Slices stay independent | ArchUnitNET rules, run with every `dotnet test` |
| Shared business rules and platform choices need you | design triggers; edits under `Shared/Domain/` ask you |
| One acceptance test per scenario | `scripts/check-scenarios.sh` |
| Free packages only | rules in `AGENTS.md`; every `dotnet add` / `aspire add` asks you |
| Work is saved only with your approval | `scripts/finish-change.sh` asks; no agent can otherwise commit |
| Deployment needs you | `aspire deploy`, `publish` and `destroy` ask; cloud sign-in is yours |
| The workflow cannot be rewritten by the agents | no agent can edit `.opencode/`, `opencode.json`, `scripts/`, `.workflow/`, `AGENTS.md` or `openspec/schemas/` |
| No agent is offered Roslynk's write tools | its 8 write tools are denied to every agent and only developer and debugger get its read-only tools; the debugger's curl and browser are kept off the daemon's port - a guard rail, like the bash rules |

Bash rules are guard rails, not a sandbox. The lock is what reliably catches a changed test, and checkpoint 3 shows the full result.

**Always answer permission prompts with "Allow once."** "Always" lasts for the session in opencode 1 and is saved for the whole project in opencode 2, which silently removes that checkpoint. Never run this workflow with `--auto`.

## Layout
```
AGENTS.md, GUIDE.md               rules every agent reads; the driver's guide
opencode.json                     default agent, MCP servers, each limited to the agents that need it; global guard rails
.opencode/agents/                 the six agents
.opencode/commands/               /setup, /feature, /bug, /deploy, /resume
.opencode/skills/vertical-slices/ examples, platform patterns, the overview command
.opencode/skills/roslynk/         when and how the developer and debugger use Roslynk
.workflow/                        acceptance.lock (commit it), debugger.env (git-ignored)
openspec/config.yaml              default schema + project context
openspec/schemas/vsa-tdd/         the feature workflow's artifacts and their instructions
openspec/schemas/vsa-tdd-bugfix/  the bug track's artifacts and their instructions
openspec/decisions/               your shared-knowledge and platform decisions
openspec/specs/                   living specs, built up change by change
scripts/                          new-solution, lock, checks, verify, finish-change
```

Conventions in your code:
```
src/<App>/Features/<Area>/<Slice>/   one flat folder per slice
src/<App>/Shared/Domain/             shared business rules (your decision only)
src/<App>/Shared/Infrastructure/     technical plumbing
src/<App>.AppHost/                   what runs (platform agent)
src/<App>.ServiceDefaults/           health, telemetry, resilience (platform agent)
tests/<App>.AcceptanceTests/         one test per scenario, locked after approval
tests/<App>.UnitTests/               the developer's inner TDD loop
tests/<App>.ArchitectureTests/       slice isolation rules (yours)
```

## Customising
- **Teach the agents your patterns:** edit `.opencode/skills/vertical-slices/references/`. Agents cannot edit the skill, so it changes only when you do.
- **Models and effort:** `model:` and `variant:` in each agent file (low, medium, high, xhigh, max). Or type `/config` in opencode to change them in your browser, picking from the models opencode lists (see `.opencode/config-editor/README.md`); restart opencode afterwards (`opencode --continue`).
- **Fewer prompts for Shared/Domain:** in `developer.md`, change `"src/*/Shared/Domain/*": ask` to `allow`.
- **Project rules for planning:** `openspec/config.yaml` (`context`, and `rules` per artifact). Keep it valid YAML: OpenSpec silently ignores a malformed file; senior-dev checks for this and stops.
- **Weak-test detection:** Stryker.NET (Apache-2.0) mutation testing can be added to `scripts/verify.sh`.
- **Upgrading Roslynk:** change the version in the `roslynk` command in `opencode.json` and read its release notes. Compare its tool list with the allowlists in `developer.md` and `debugger.md` - allow only tools it marks read-only - then update `.opencode/skills/roslynk/SKILL.md` to match.

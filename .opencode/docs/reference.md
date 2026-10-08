# Reference

Where everything lives, the conventions in your code, and how to change the workflow to suit you.

## Layout

```
AGENTS.md, GUIDE.md               rules every agent reads; the driver's guide
opencode.json                     default agent, MCP servers, each limited to the agents that need it; global guard rails
.opencode/agents/                 the six agents
.opencode/commands/               /setup, /feature, /bug, /deploy, /resume, /config, /costings, /diagram, /classes
.opencode/docs/                   setup, how the workflow runs, what is enforced, this reference
.opencode/skills/vertical-slices/ examples, platform patterns, the overview command
.opencode/skills/roslynk/         when and how the developer and debugger use Roslynk
.opencode/plugins/                usage-recorder.js: records each model reply's tokens
.opencode/costings/               the /costings page, its CSV exports and the recorder's logic
.opencode/config-editor/          the /config page
.opencode/diagrams/               the /diagram and /classes pages, and the C# reader behind them
.opencode/lib/                    plumbing shared by the local pages
.workflow/                        acceptance.lock (commit it), debugger.env and usage.db (git-ignored)
openspec/config.yaml              default schema + project context
openspec/schemas/vsa-tdd/         the feature workflow's artifacts and their instructions
openspec/schemas/vsa-tdd-bugfix/  the bug track's artifacts and their instructions
openspec/decisions/               your shared-knowledge and platform decisions
openspec/specs/                   living specs, built up change by change
scripts/                          install-tools, new-solution, lock, checks, verify, finish-change
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
- **Upgrading Roslynk:** change the version in the `roslynk` command in `opencode.json` and read its release notes. Compare its tool list with the allowlists in `developer.md` and `debugger.md` - allow only tools it marks read-only - then update `.opencode/skills/roslynk/SKILL.md` to match. `scripts/install-tools.mjs` reads the version from `opencode.json`, so it downloads the new one next time it runs.

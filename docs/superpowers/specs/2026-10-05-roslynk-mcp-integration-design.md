# Roslynk in the opencode workflow - design

- **Date**: 2026-10-05
- **Branch**: `claude/roslynk-mcp-integration-030840`
- **Upstream**: https://github.com/mrpmorris/Roslynk (MIT), NuGet package `Roslynk`, version 2.0.0

## Goal

Give the agents that read and change C# a compiler-backed view of the solution - near-instant compile checks, go-to-definition, find-references, callers, implementations - instead of grep, whole-file reads and slow `dotnet build` runs. It ships with the template, so every project made from it gets it.

Nothing about the workflow's boundaries changes: the per-agent edit rules, the acceptance-test lock and the three checkpoints work exactly as before.

### What the human asked for
- A branch for adding Roslynk to this template.
- Custom MCP files where needed to make it compatible.

### What this design assumes (confirmed during brainstorming)
- "Compatible" means **opencode**, the template's harness. Roslynk documents setup for Claude Code, VS Code, Cursor and DeepSeek Harness, but not opencode.
- **Read-only for every agent.** Roslynk's write tools are never exposed.
- **Only the developer and the debugger** get the read-only tools.
- No custom MCP server code. The "custom MCP files" are an opencode MCP entry, an opencode-specific skill, and permission rules.

## Why read-only

opencode permissions match an MCP tool by name only. They cannot limit the paths a tool touches. Roslynk's write tools write straight to disk:

- `/setup` puts the solution file at the repository root, and `apply_patch` edits any existing text file under the solution's folder. That reaches `AGENTS.md`, `opencode.json`, `.opencode/`, `scripts/` and `.workflow/acceptance.lock`, all of which every agent is forbidden to edit.
- `rename_symbol`, `rename_parameter` and `change_signature` cascade into every file that uses the symbol, including locked acceptance tests and `*.Contracts.cs`.
- Code fixes and refactorings (`apply_code_fix`, `apply_code_action`, `extract_method`, `remove_unused_usings`) write wherever Roslyn decides.

Exposing any of them would bypass the edit boundaries, and `apply_patch` could even rewrite the lock that is meant to catch a changed test.

## Approach: explicit allowlist

A global `"roslynk_*": "deny"` blocks every Roslynk tool for every agent, the same pattern the template already uses for `playwright_*` and `aspire_*`. `developer.md` and `debugger.md` then allow the read-only tools by exact name.

A tool added by a future Roslynk version therefore stays blocked until someone reviews it. Pinning the version (below) adds a second layer: the tool list only changes when someone edits the version.

Rejected alternatives:
- **Deny-list** (allow `roslynk_*`, deny the 8 write tools): a new write tool in a later version would be allowed silently.
- **opencode `tools:` switches**: older than permissions, and inconsistent with the rest of the template.
- **A path-guarded proxy MCP server** (a Node wrapper that previews each write with `checkOnly` and refuses out-of-bounds paths): more capability, but new code to maintain, and a guard rail rather than a hard boundary. Not needed once all writes are excluded.

## Components

### 1. `opencode.json`

A new entry under `mcp`:

```json
"roslynk": {
  "type": "local",
  "command": ["dnx", "Roslynk@2.0.0", "--yes", "--", "stdio"],
  "enabled": true,
  "timeout": 60000
}
```

- `dnx` ships with the .NET 10 SDK, which is already a prerequisite. It downloads the pinned package on first use (`--yes` skips the prompt), so there is no install step.
- The trailing `stdio` is required. Without it Roslynk starts as an HTTP daemon and never answers the MCP handshake.
- `timeout` is raised from opencode's 5-second default because the first start downloads the package, and Roslynk waits up to 30 seconds for its background process to start.
- **Upgrading is deliberate**: change the version, compare the new tool list with the allowlists, update the skill. Version 2.0.0 itself made breaking changes, which is why the version is pinned.

Two additions to the global `permission` block:

```json
"skill": {
  "openspec-*": "deny",
  "roslynk": "deny"
},
"playwright_*": "deny",
"aspire_*": "deny",
"roslynk_*": "deny"
```

### 2. Agent permissions (`developer.md`, `debugger.md`)

Each agent's frontmatter allows exactly the 20 tools that Roslynk 2.0.0 annotates `ReadOnly = true`, plus the skill:

```yaml
  "roslynk_open_solution": allow
  "roslynk_get_solution_status": allow
  "roslynk_reload_solution": allow
  "roslynk_find_definition": allow
  "roslynk_get_expression_info": allow
  "roslynk_get_symbol": allow
  "roslynk_get_symbol_body": allow
  "roslynk_get_members": allow
  "roslynk_search_symbols": allow
  "roslynk_multi_query": allow
  "roslynk_find_references": allow
  "roslynk_find_reads": allow
  "roslynk_find_writes": allow
  "roslynk_get_callers": allow
  "roslynk_find_implementations": allow
  "roslynk_get_type_hierarchy": allow
  "roslynk_get_diagnostics": allow
  "roslynk_get_code_actions": allow
  "roslynk_find_dead_code": allow
  "roslynk_find_dead_conditionals": allow
  skill:
    "roslynk": allow
```

`open_solution` and `reload_solution` change only Roslynk's in-memory workspace, never files. `multi_query` accepts only read-only operations. `get_code_actions` lists fixes but cannot apply them.

**Never allowed for any agent**: `apply_patch`, `rename_symbol`, `rename_parameter`, `change_signature`, `extract_method`, `remove_unused_usings`, `apply_code_action`, `apply_code_fix`.

senior-dev, test-writer, test-reviewer and platform get nothing: the global deny applies to them unchanged.

### 3. Skill: `.opencode/skills/roslynk/SKILL.md`

Written fresh for this workflow, not copied from upstream. Roslynk's own skill uses Claude Code's tool names (`mcp__roslynk__*`) and tells agents to prefer `apply_patch` and "never fall back to reading or editing files directly", which conflicts with this workflow. The new skill links to upstream's skill (pinned to the 2.0.0 commit) as the deeper reference.

Contents:
- **When**: questions about C# code (`.cs`, `.razor`, `.cshtml`) in the solution. Tools are named `roslynk_*`.
- **Setup**: call `roslynk_open_solution` with the absolute path of the root `.slnx` (or `.sln`); the working directory is in the agent's environment. If there is no solution yet, don't use Roslynk. On `error=Indexing`, retry shortly or poll `roslynk_get_solution_status`.
- **Semantic over text**: a short table mapping questions to tools (`find_references`, `get_callers`, `find_implementations`, `get_symbol_body`, `find_definition`, `get_expression_info`), and `multi_query` for impact analysis in one call.
- **Compile checks**: `get_diagnostics` (a bare call reports counts; then `includeErrors=true`) is the fast check while working. It does not run tests: `dotnet test` stays the proof, and its results go in the report.
- **Editing**: Roslynk's write tools are not available. Edit with the normal edit tool; Roslynk's file watcher picks up the change. Treat `get_code_actions` results as suggestions to apply by hand. A denied tool is a boundary (AGENTS.md): never reach the same result another way.
- **Reload**: call `reload_solution` only when results are clearly stale, for example after a package restore or a branch switch.
- **If Roslynk is unavailable**: the server fails to start, or tools keep returning errors. Continue with the normal tools and say so in the report. Never block on it.
- **Conventions**: fully-qualified names; `candidate=` lines on `Ambiguous`/`NotFound` are copied back verbatim; watch for `truncated=Y`.

### 4. Agent instructions

Additions only; no existing text changes.

- **`developer.md`**, under "Before you write anything": load the **roslynk** skill; use it to find code and for fast compile checks while you work; `dotnet test` stays the proof.
- **`debugger.md`**, under "Your tools": a **Roslynk** bullet - trace from the endpoint to the failure with `find_definition`, `get_callers` and `find_references`, and read members with `get_symbol_body` instead of whole files; load the **roslynk** skill.

### 5. README.md

- **Prerequisites**: note that the .NET 10 SDK includes `dnx`, which fetches Roslynk on first use.
- **Layout**: add `.opencode/skills/roslynk/`. Change `opencode.json`'s comment from "MCP servers (debugger only)" to "MCP servers, each limited to the agents that need it".
- **New section "Roslynk, read-only"**:
  - What it is, and the pinned version.
  - Who gets it (developer, debugger), and that its write tools are denied to every agent.
  - It runs a shared background process on `localhost:6502` that keeps running after opencode exits (it unloads a solution after 30 idle minutes but does not exit). Its log is `Roslynk/daemon.log` under the local application-data folder (`~/.local/share` on Linux and WSL). How to stop it.
  - If port 6502 is already taken (for example by a Roslynk started on the Windows side with WSL mirrored networking), set `"environment": { "Roslynk__Port": "<port>" }` on the `roslynk` entry.
- **"What is enforced, and how" table**: new row - *Roslynk cannot change files* | *its 8 write tools are denied to every agent; only developer and debugger get the read-only tools*.
- **Customising**: how to upgrade Roslynk.

### Not changing
- `AGENTS.md`: its boundary rule ("a denied edit is a boundary: never make the same change through bash or another route") already covers Roslynk, and four of the six agents never see it.
- `GUIDE.md`: the non-technical guide; nothing changes for the human driving the workflow.
- `scripts/`, `.workflow/`, `openspec/`, the config editor.

## Verification

1. **Roslynk smoke test** (throwaway script in a temporary folder, not committed):
   - Run the exact `command` from `opencode.json`, send MCP `initialize` and `tools/list`.
   - `Roslynk@2.0.0` resolves; 28 tools are listed.
   - Each of the 20 allowlisted names exists and is annotated `readOnlyHint: true`; each of the other 8 is one of the listed write tools.
   - Open a throwaway `dotnet new classlib` solution and call `get_diagnostics`: it returns counts.
   - Record the daemon's process command line (for the README's stop instructions), then stop it.
2. **Config editor tests**: `node --test .opencode/config-editor/test/` passes. Its tests copy `opencode.json` and the agent files, so they catch broken JSON or frontmatter.
3. **opencode** (installed with `npm i -g opencode-ai` - approved): the config loads without errors, `roslynk` connects and lists its tools, and the resolved permissions for developer and debugger show the allowlist with the global deny for the rest.

## Out of scope
- Claude Code configuration (`.mcp.json`, `.claude/skills`).
- Roslynk for senior-dev, test-writer, test-reviewer or platform. Adding one later means copying the allowlist into that agent's file.
- Any of Roslynk's write tools, or a proxy that path-guards them.
- Changing `scripts/verify.sh` or any gate: `dotnet build` and `dotnet test` stay authoritative.

## Risks
- **Upstream moves fast**: 2.0.0 was a breaking release. Pinning plus the allowlist contain it; the README's upgrade steps make upgrades a reviewed change.
- **Shared unauthenticated daemon**: it binds to loopback only, but any local process can call it, including its write tools. That is upstream's design and fine for local development, which is the only place this workflow runs it.
- **Stale results**: if the file watcher misses a change, answers can be out of date. `get_diagnostics` is an accelerator; `dotnet test` is still the proof.

## Changes after the final review

A fresh review of the whole branch found three gaps in this design; they were fixed before merging.

- **Roslynk's own server instructions conflict with this workflow.** opencode puts each connected server's instructions into the system prompt of every agent that can use any of its tools. Roslynk's say "You MUST use Roslynk over reading or hand-patching .cs ... files yourself" and "To fix a diagnostic, call apply_code_fix ... never hand-edit". `developer.md`, `debugger.md` and the skill now say that this guidance does not apply here, and the skill explicitly allows `reload_solution` when answers are stale (its own description says to call it only when told to).
- **A failed load looks like loading.** Roslynk returns `error=Indexing` with `status=Faulted` when a solution fails to load. The skill now treats `status=Faulted`, or loading for more than about two minutes, as "Roslynk unavailable".
- **The daemon is reachable from the debugger's own tools.** The debugger may `curl` localhost and drive a browser limited to localhost, and the daemon serves all 28 tools, including the write tools, to any local connection. `debugger.md` now denies `curl *:6502*` and the Playwright server blocks `http://localhost:6502` (`--blocked-origins`). The README calls this a guard rail, like the bash rules, and its enforcement row now reads "No agent is offered Roslynk's write tools" instead of "Roslynk cannot change files".
- The README also now says that opencode starts Roslynk with every session in the project, not only when an agent uses it.

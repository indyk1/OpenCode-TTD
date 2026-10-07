# What is enforced, and how

The checkpoints only mean something if the agents cannot get around them. This page lists each rule and what holds it in place, then the two tools that need extra care: the debugger's browser and Roslynk.

## The rules

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

## The debugger, safely

- It runs a **local** copy only. The browser is a headless Playwright MCP server limited to `localhost` (`--allowed-origins`). Playwright documents origin filtering as a guard rail rather than a security boundary, so never point the debugger at a real environment.
- Its credentials live in `.workflow/debugger.env`, which git ignores. The browser server receives the file as its secrets file and masks those values in everything it returns to the agent. If the agent ever needs to read the file itself, you are asked first. Use a local-only test account - never a real one.
- The browser and Aspire MCP tools are denied to every agent except the debugger.

## Roslynk, read-only

[Roslynk](https://github.com/mrpmorris/Roslynk) (MIT) gives the developer and the debugger a live Roslyn compilation of the solution: go to definition, find references and callers, read a single member, and compile errors near-instantly instead of after a full `dotnet build`. `opencode.json` pins Roslynk 2.0.0 and starts it through `dnx`, so there is nothing to install (`scripts/install-tools.mjs` downloads it ahead of time, so the first start is quick).

- **Read-only.** `opencode.json` denies every `roslynk_*` tool; `developer.md` and `debugger.md` allow its 20 read-only tools by name. Its 8 editing tools (`apply_patch`, `rename_symbol`, `rename_parameter`, `change_signature`, `extract_method`, `remove_unused_usings`, `apply_code_action`, `apply_code_fix`) write straight to disk and could reach the tests, the lock and the workflow files, so no agent gets them. Edits still go through each agent's own edit permissions.
- **A shared background process.** opencode starts Roslynk with every session in the project - only the developer and the debugger can use its tools - and the first start launches a daemon on `localhost:6502` (loopback only, no sign-in) that later sessions share. It unloads a solution after 30 idle minutes but keeps running after opencode exits. Its log is `Roslynk/daemon.log` in your local application data folder: `~/.local/share` on Linux, `~/Library/Application Support` on macOS, `%LOCALAPPDATA%` on Windows. To stop it, run `pkill -f Morris.Roslynk.Mcp` on macOS and Linux, or this in PowerShell on Windows: `Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%Morris.Roslynk.Mcp%'" | Invoke-CimMethod -MethodName Terminate`.
- **Kept off the daemon's port.** The daemon accepts any local connection, including calls to its editing tools, so `debugger.md` denies `curl *:6502*` and the browser server blocks `http://localhost:6502` (`--blocked-origins`). Like the bash rules, this is a guard rail, not a sandbox.
- **Port 6502 taken?** Give the `roslynk` entry in `opencode.json` its own port: `"environment": { "Roslynk__Port": "6517" }`, and change `6502` to match in the debugger's `curl *:6502*` rule and in the browser server's `--blocked-origins`.
- **Not available?** The agents carry on with their usual tools and say so in their report.

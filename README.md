# Vertical slices, test-first: an opencode workflow for .NET and Aspire

A team of AI agents builds a .NET application with you. You describe what you want in plain English; they plan it, write the tests first, build it as vertical slices, check it, and save it - coming back to you at three checkpoints. Nothing moves past a checkpoint without your approval, and you never need to read code to give it.

Built on .NET 10, ASP.NET Core minimal APIs and .NET Aspire, tested with NUnit and NSubstitute, planned with OpenSpec. Runs on Windows, macOS and Linux.

- **Driving it day to day?** Read [GUIDE.md](GUIDE.md).
- **Installing it?** Go to [Setup](#setup).
- **Want the detail?** See [Documentation](#documentation).

## How it works

Every change goes through the same gated loop. Each checkpoint is a permission prompt - your signature.

| Step | Who | What happens | Your checkpoint |
|---|---|---|---|
| 1. Plan | senior-dev | Writes the OpenSpec change - proposal, GIVEN/WHEN/THEN scenarios, design, test plan, tasks - and asks you its business and platform questions in plain English | Approve the plan: *launch test-writer* |
| 2. Red | test-writer, test-reviewer | One failing acceptance test per scenario, checked by a different model and summarised for you in plain English | Approve the tests: *scripts/lock-tests.sh* |
| 3. Green | developer | Implements slice by slice until the locked tests pass; it cannot touch them | - |
| 4. Verify | senior-dev | Build, every test, the lock, scenario coverage and architecture rules, then a review of the diff | Accept the result: *scripts/finish-change.sh* |

Bugs take a lighter track with two checkpoints: the debugger reproduces the bug on a local copy and explains the cause, a test is written that fails *because of the bug*, and then it is fixed. Step by step: [.opencode/docs/workflow.md](.opencode/docs/workflow.md).

## The agents

### Primary agents - the ones you talk to

| Agent | Model | Effort | Does | Can edit |
|---|---|---|---|---|
| **senior-dev** (default) | Claude Opus 5.5 | high | Plans with OpenSpec, asks you business and platform questions in plain English, writes the test plan, delegates, verifies, saves | `openspec/` only |
| **platform** (also a subagent) | Claude Sonnet 5.5 | high | `/setup`, `/deploy`, and Aspire resources such as a database when a plan needs one | the Aspire projects, app wiring and test infrastructure, platform decisions |

### Subagents - launched for you, one job each

| Agent | Model | Effort | Does | Can edit |
|---|---|---|---|---|
| **test-writer** | Claude Sonnet 5.5 | high | Turns the test plan into failing acceptance tests and empty slice contracts | acceptance tests, `*.Contracts.cs` |
| **test-reviewer** | Claude Opus 5.5 | high | Checks the tests independently and describes each in plain English | nothing |
| **developer** | Claude Sonnet 5.5 | medium | Implements one slice at a time until its locked tests pass, with its own unit tests | `src/` except contracts and the Aspire projects; unit tests |
| **debugger** | Claude Opus 5.5 | high | Reproduces a bug locally in a browser, reads logs, traces and code, explains the cause and fix | its investigation file only |

The writer and the reviewer are different models on purpose: tests are checked by someone other than their author. Change any agent's model or effort with [`/config`](#costings-and-config). Each agent's instructions and permissions are in `.opencode/agents/`.

## Commands for building

### In opencode

| Command | When | Example |
|---|---|---|
| `/setup <Title> - <what it does>` | once, for a brand-new app | `/setup Acme Orders - lets small shops take orders online and track deliveries` |
| `/feature <what you want>` | you want something new | `/feature Shop owners can see today's orders, newest first` |
| `/bug <what happened>` | something isn't working | `/bug Cancelling an order with two items shows an error. I expected "Order cancelled".` |
| `/deploy` | put it online, or update it | `/deploy` |
| `/resume <change-name>` | carry on after closing opencode; its state lives in `openspec/changes/<name>/status.md` | `/resume cancel-orders` |

### In a terminal

| Command | Does |
|---|---|
| `aspire start` / `aspire stop` | run the app and its resources in the background, with the Aspire dashboard |
| `dotnet build`, `dotnet test` | build; run every test - acceptance, unit and architecture |
| `scripts/verify.sh <change>` | everything senior-dev checks before checkpoint 3 |
| `scripts/check-test-lock.sh` | are the locked tests untouched? (`--list` shows what changed) |
| `scripts/check-scenarios.sh <change> --plan\|--tests` | one test-plan entry, or one test, per scenario |
| `.opencode/skills/vertical-slices/scripts/overview.sh [slices\|shared\|platform]` | existing slices, shared business rules, platform decisions |

On Windows, run the `scripts/` commands from Git Bash; the others work in any terminal.

## Costings and config

Two small web pages that run on your own computer (`127.0.0.1` only). They need only Node.js - nothing to install.

| Command | Opens | Details |
|---|---|---|
| `/costings` | How many tokens each agent used on each feature and bug, with CSV export. An opencode plugin records every model reply into `.workflow/usage.db`, which stays on your computer. Tokens, not money. | [.opencode/costings/README.md](.opencode/costings/README.md) |
| `/config` | Each agent's model and effort, picked from the models opencode lists. Restart opencode afterwards (`opencode --continue`). | [.opencode/config-editor/README.md](.opencode/config-editor/README.md) |

Each takes one short model turn. To skip it, type `!node .opencode/costings/server.mjs --open --detach` (or `config-editor`) in opencode's shell mode. Both pages stop by themselves after 15 minutes without activity.

## Setup

You install two things by hand - the **.NET 10 SDK** and **Node.js 22.13+** - and a script does the rest. It is plain Node and `dotnet`, so the same script runs on Windows, macOS and Linux.

1. Install the [.NET SDK](https://dot.net) 10 or later and [Node.js](https://nodejs.org) 22.13 or later.
2. Copy this template into the root of your project folder. It does not need to be a git repository yet.
3. In that folder, run `node scripts/install-tools.mjs`. Run it again any time: it skips what is already there and lists what is still missing.
4. If it says the agents' models are not available, sign opencode in: `opencode auth login`.
5. New application: run `opencode`, then `/setup <Title> - <what it does>`. Existing solution: see [.opencode/docs/setup.md](.opencode/docs/setup.md#existing-solution).
6. Commit.

What the script installs or checks:

| Tool | Needed for | The script |
|---|---|---|
| OpenSpec CLI | senior-dev's planning | installs it: `npm install -g @fission-ai/openspec@latest` |
| opencode 1.14.27+ | running the agents | installs it (`npm install -g opencode-ai@latest`), then checks it lists the models the agents use (`claude-opus-5-5` and `claude-sonnet-5-5`) |
| Aspire CLI | `aspire start`, the dashboard, `/deploy` | installs it: `dotnet tool install -g Aspire.Cli` |
| Aspire project templates | `/setup`, and adding Aspire to an existing solution | installs them: `dotnet new install Aspire.ProjectTemplates` |
| Playwright and Google Chrome | the debugger's headless browser | fetches the Playwright MCP server, and installs Chrome if it is missing (`npx playwright install chrome`, which may ask for your password) |
| Roslynk 2.0.0 | live code navigation for the developer and the debugger | downloads it ahead of time, so opencode's first start is quick |
| git | saving each change; on Windows, Git Bash - the shell opencode runs the agents' commands in | checks it is installed, with `user.name` and `user.email` set (and Git Bash on Windows) |
| Podman or Docker | databases and other resources, in the app and in the tests | checks one is installed and running; on macOS, also Podman's settings |
| Azure CLI | `/deploy` to Azure only | checks it is installed; signing in (`az login`) is yours |

It does not install git, Podman or Docker itself - they need admin rights or a licence decision (Docker Desktop needs a paid subscription in larger organisations) - so it prints the exact command for your system instead.

**On Windows** you work in PowerShell or Windows Terminal as usual - no WSL. opencode runs the agents' commands in Git Bash, which comes with Git for Windows. WSL still works if you prefer it.

Installing by hand, macOS and Windows notes, and existing solutions: [.opencode/docs/setup.md](.opencode/docs/setup.md).

Do not run `openspec init --tools opencode` or `aspire agent init`: they add generic commands, skills and MCP configuration that bypass this workflow's checkpoints and permissions. The template already configures what it needs.

## Staying safe

- **Always answer permission prompts with "Allow once."** "Always" lasts for the session in opencode 1 and is saved for the whole project in opencode 2, which silently removes that checkpoint.
- **Never start opencode with `--auto`.**
- Each agent can edit only its own areas, and no agent can edit the workflow itself: `.opencode/`, `opencode.json`, `scripts/`, `.workflow/`, `AGENTS.md` and `openspec/schemas/`.

What is enforced and how, the debugger's local-only browser, and Roslynk's read-only tools: [.opencode/docs/safety.md](.opencode/docs/safety.md).

## Documentation

| Read | For |
|---|---|
| [GUIDE.md](GUIDE.md) | the person driving it: what to type, the two kinds of pop-up, the golden rules |
| [.opencode/docs/setup.md](.opencode/docs/setup.md) | installing by hand, macOS and Windows notes, adding the workflow to an existing solution |
| [.opencode/docs/workflow.md](.opencode/docs/workflow.md) | how a feature and a bug run, step by step; platform decisions and Aspire |
| [.opencode/docs/safety.md](.opencode/docs/safety.md) | what is enforced and how; the debugger, safely; Roslynk, read-only |
| [.opencode/docs/reference.md](.opencode/docs/reference.md) | the template's layout, conventions in your code, customising |
| [.opencode/costings/README.md](.opencode/costings/README.md) | token usage: how it is recorded, the page, CSV columns, options |
| [.opencode/config-editor/README.md](.opencode/config-editor/README.md) | the model and effort editor |
| [AGENTS.md](AGENTS.md) | the rules every agent reads |
| [.workflow/README.md](.workflow/README.md) | the test lock, the debugger's test account, the usage database |

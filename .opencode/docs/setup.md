# Setup

Everything needed to get the workflow running on a computer: what it needs, the install script, and notes for Windows, macOS, Linux and existing solutions.

## What it needs

- .NET SDK 10 or later (it includes `dnx`, which runs Roslynk)
- Node.js 22.13+ (its built-in SQLite holds the token usage behind `/costings`; Node 20 reached end of life in April 2026)
- git, with `user.name` and `user.email` set. On Windows, Git for Windows, which also brings Git Bash.
- [opencode](https://opencode.ai) 1.14.27 or later. `opencode.json` sets `"shell": "bash"`, so the agents' commands run in bash on every system - the same shell opencode's permission rules are written for: Git Bash on Windows, bash on macOS and Linux. Older versions refuse to start with that setting.
- The OpenSpec CLI, for planning
- The [Aspire CLI](https://aspire.dev/get-started/install-cli/) and the Aspire project templates
- Playwright's MCP server and Google Chrome, for the debugger's browser
- Roslynk 2.0.0, pinned in `opencode.json` and started through `dnx`
- Podman (free) or Docker, for databases and other resources. Docker Desktop needs a paid subscription in larger organisations.
- The Azure CLI, only to `/deploy` to Azure

## The install script

Install the .NET SDK and Node.js yourself, then run this in the project folder:

```
node scripts/install-tools.mjs
```

It installs the rest through npm and `dotnet` - the OpenSpec CLI, opencode, the Aspire CLI and its project templates, Roslynk and the Playwright MCP server, and Google Chrome if it is missing - and checks what it cannot install itself: git and your name and email, Git Bash on Windows, Podman or Docker (and, on a Mac, Podman's settings), the Azure CLI, and that opencode lists the models the agents use. For each thing still missing it prints the command that fixes it.

- **Run it again any time.** It skips what is already in place. Add `--check` to only report and install nothing.
- **It finishes with a summary.** "Everything this workflow needs is in place" (exit code 0), or how many things still need your attention (exit code 1).
- **Open a new terminal afterwards** if it installed something, so opencode finds it on your `PATH`.
- **npm says "EACCES"?** Your Node.js was installed for the whole system, so npm cannot install global packages without admin rights. Use a Node.js installer from [nodejs.org](https://nodejs.org) or a version manager, or see [npm's guide](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally).

## Step by step

1. Install the .NET SDK and Node.js (see your system below).
2. Copy this template into the root of your project folder. It does not need to be a git repository yet: `/setup` creates one if needed, and adds a `.gitignore` that keeps build output and local settings files (`local.settings.json`, `.env`) out of git - local development secrets go in user secrets. The template adds only `.opencode/`, `opencode.json`, `AGENTS.md`, `GUIDE.md`, `openspec/`, `scripts/`, `.workflow/` and `.gitattributes` (which keeps the scripts runnable on Windows; if your project already has one, add its line to yours).
3. Run `node scripts/install-tools.mjs` in that folder and fix anything it reports.
4. If it says the agents' models are not available, sign opencode in to Anthropic: `opencode auth login`. `opencode models anthropic` should list `claude-opus-5-5` and `claude-sonnet-5-5`. If not, update opencode (`opencode upgrade`); for another provider, change the models with `/config` or the `model:` lines in `.opencode/agents/*.md`.
5. New application: run `opencode` and `/setup <Title> - <what it does>`. Existing solution: see [below](#existing-solution).
6. Commit.

Do not run `openspec init --tools opencode` or `aspire agent init`: they add generic commands, skills and MCP configuration that bypass this workflow's checkpoints and permissions. The template already configures what it needs.

## Windows

Everything runs natively: you work in PowerShell or Windows Terminal as usual. With [winget](https://learn.microsoft.com/windows/package-manager/winget/):

```
winget install --id Microsoft.DotNet.SDK.10 -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Git.Git -e
```

Open a new terminal, then run `node scripts/install-tools.mjs`.

- **Git Bash.** opencode runs the agents' commands in the Git Bash that comes with Git for Windows. It finds it next to `git`; if yours is somewhere else, set `OPENCODE_GIT_BASH_PATH` to its `bash.exe`. To run the `scripts/` yourself, use Git Bash too.
- **Line endings.** Git for Windows checks files out with Windows line endings. `.gitattributes` keeps the scripts runnable anyway, and the test lock ignores line endings, so tests locked on Windows still match on a Mac, on Linux and in CI.
- **Containers.** Docker Desktop works as it is. For Podman, install Podman Desktop (`winget install --id RedHat.Podman-Desktop -e`) and let it create its machine; turn on its Docker compatibility so Testcontainers, which runs the acceptance tests' databases, can find it; and set `ASPIRE_CONTAINER_RUNTIME` to `podman` (`setx ASPIRE_CONTAINER_RUNTIME podman`, then open a new terminal). After restarting Windows, start Podman before opencode: `podman machine start`, or open Podman Desktop.
- **WSL instead?** Everything also works inside WSL, which is a Linux machine as far as the workflow is concerned: install the tools inside WSL, not on the Windows side, and follow [Linux](#linux). Token usage then stays inside WSL.

## macOS

Everything runs natively in Terminal; only Podman uses a virtual machine, for the containers. With [Homebrew](https://brew.sh):

```bash
xcode-select --install
brew install --cask dotnet-sdk google-chrome
brew install node podman
```

Then run `node scripts/install-tools.mjs`.

- **Open a new Terminal window** afterwards. opencode passes on the `PATH` of the Terminal it was started from, and the installers add themselves to it only for new windows.
- **Chrome must be in `/Applications`** (where the installer puts it): it is the only place the debugger's browser looks.
- **Podman** runs inside a Linux virtual machine. Create it once with `podman machine init`; start it with `podman machine start` after every restart of the Mac, or install Podman Desktop (`brew install --cask podman-desktop`), which can start it at login. Then add these lines to `~/.zshrc` and open a new Terminal window:
  ```bash
  export ASPIRE_CONTAINER_RUNTIME=podman
  export DOCKER_HOST="unix://$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}')"
  export TESTCONTAINERS_RYUK_DISABLED=true
  ```
  Testcontainers, which runs the acceptance tests' databases, looks only for Docker unless `DOCKER_HOST` points it at Podman. Its clean-up container (Ryuk) cannot run on rootless Podman on a Mac, so a test run that crashes can leave its containers running: `podman ps` lists them and `podman rm -f <name>` removes one. With Docker Desktop instead of Podman, none of this is needed. The install script checks these three settings.

## Linux

Install the .NET SDK, Node.js, git and Podman (or Docker) with your distribution's packages, then run `node scripts/install-tools.mjs`. Installing Chrome (`npx playwright install chrome`) asks for your password, because it adds a system package.

## Existing solution

Bring it to .NET 10 and add Aspire (`dotnet new install Aspire.ProjectTemplates`, then `aspire-apphost` and `aspire-servicedefaults` projects named `<App>.AppHost` and `<App>.ServiceDefaults`). Make sure `tests/<App>.AcceptanceTests` (NUnit, `Microsoft.AspNetCore.Mvc.Testing`, `NSubstitute`) and `tests/<App>.UnitTests` (NUnit, `NSubstitute`) exist. Recommended: the architecture tests from `.opencode/skills/vertical-slices/references/architecture-tests.md`. Describe the application in `openspec/config.yaml` (`  Application: <Title> - <what it does>` as the first line of the `context` block), write your platform decisions in `openspec/decisions/platform.md`, and lock any existing acceptance tests: `scripts/lock-tests.sh initial`.

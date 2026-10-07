#!/usr/bin/env node
// Usage: node scripts/install-tools.mjs [--check]
//
// Installs, or checks, the tools this workflow needs on this computer - the same way on Windows, macOS and
// Linux. It needs only Node.js and the .NET SDK; everything it installs comes through npm or dotnet:
//   OpenSpec CLI, opencode              npm install -g
//   Aspire CLI                          dotnet tool install -g Aspire.Cli
//   Aspire project templates            dotnet new install Aspire.ProjectTemplates
//   Roslynk (the version opencode.json pins)   downloaded into the NuGet cache, where dnx looks first
//   Playwright MCP server               npx, and `playwright install chrome` when Google Chrome is missing
// What needs admin rights or a licence decision - git, Podman or Docker, the Azure CLI - is only checked,
// and the command that installs it is printed. It also checks that opencode is signed in to the agents'
// models and that git knows your name and email.
//
//   --check   report only; install nothing
//
// Run it again any time: it skips what is already in place.
// Exit codes: 0 everything needed is in place, 1 something needs your attention, 2 usage error.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN_NODE = [22, 13, 0]; // node:sqlite, behind /costings
const MIN_DOTNET = [10, 0, 0];
const MIN_OPENCODE = [1, 14, 27]; // the "shell" setting in opencode.json

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isWsl = process.platform === 'linux' && (Boolean(process.env.WSL_DISTRO_NAME) || /microsoft/i.test(os.release()));

const args = process.argv.slice(2);
if (args.some((a) => a !== '--check')) {
  console.error('usage: node scripts/install-tools.mjs [--check]');
  process.exit(2);
}
const checkOnly = args.includes('--check');

let attention = 0;
let installedSomething = false;

function report(status, name, detail = '') {
  if (status === 'missing') attention++;
  console.log(`  ${status.padEnd(10)} ${name}${detail ? ` - ${detail}` : ''}`);
}

// npm, npx, openspec, opencode, dnx and az are .cmd files on Windows, which Node runs only through a shell.
// Every argument here is fixed by this script; paths go through `cwd`, never on the command line.
function run(cmd, cmdArgs = [], { cwd = ROOT, inherit = false, timeoutMs = 120_000 } = {}) {
  const options = { cwd, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe', timeout: timeoutMs, windowsHide: true };
  const result = isWindows
    ? spawnSync([cmd, ...cmdArgs].join(' '), { ...options, shell: true })
    : spawnSync(cmd, cmdArgs, options);
  const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  return { ok: !result.error && result.status === 0, out };
}

function versionOf(text) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

function atLeast(version, min) {
  for (let i = 0; i < 3; i++) if (version[i] !== min[i]) return version[i] > min[i];
  return true;
}

const show = (version) => version.join('.');

function firstLine(text) {
  return (text ?? '').split(/\r?\n/).find((line) => line.trim()) ?? '';
}

// Runs an install command where you can see it. Returns whether it worked.
function install(name, cmd, cmdArgs, { why = '' } = {}) {
  const line = [cmd, ...cmdArgs].join(' ');
  if (checkOnly) {
    needs(name, `install it: ${line}${why ? ` (${why})` : ''}`);
    return false;
  }
  console.log(`  installing ${name}: ${line}`);
  const { ok } = run(cmd, cmdArgs, { inherit: true, timeoutMs: 15 * 60_000 });
  if (ok) installedSomething = true;
  return ok;
}

function opencodeConfig() {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, 'opencode.json'), 'utf8'));
  } catch {
    return {};
  }
}

// "provider/model" from every agent's model: line, so a model changed with /config is checked too.
function agentModels() {
  const dir = path.join(ROOT, '.opencode', 'agents');
  const models = new Set();
  for (const file of existsSync(dir) ? readdirSync(dir) : []) {
    if (!file.endsWith('.md')) continue;
    const m = /^model:\s*(\S+)\s*$/m.exec(readFileSync(path.join(dir, file), 'utf8'));
    if (m) models.add(m[1]);
  }
  return [...models];
}

function needs(name, why) {
  report('missing', name, why);
}

function checkNode() {
  const version = versionOf(process.versions.node);
  if (atLeast(version, MIN_NODE)) report('ok', 'Node.js', show(version));
  else needs('Node.js', `${show(MIN_NODE)} or later is needed for /costings (this is ${show(version)}): https://nodejs.org`);
}

function checkDotnet() {
  const { ok, out } = run('dotnet', ['--version']);
  const version = ok ? versionOf(out) : null;
  if (!version) {
    needs('.NET SDK', 'install 10 or later: https://dot.net');
    return false;
  }
  if (!atLeast(version, MIN_DOTNET)) {
    needs('.NET SDK', `10 or later is needed for Aspire and dnx (found ${firstLine(out)}): https://dot.net`);
    return false;
  }
  report('ok', '.NET SDK', firstLine(out));
  return true;
}

function checkGit() {
  const { ok, out } = run('git', ['--version']);
  if (!ok) {
    const how = isWindows ? 'winget install --id Git.Git -e' : isMac ? 'xcode-select --install' : 'sudo apt install git, or your distribution\'s package';
    needs('git', `install it: ${how}`);
    return;
  }
  const name = firstLine(run('git', ['config', '--get', 'user.name']).out);
  const email = firstLine(run('git', ['config', '--get', 'user.email']).out);
  if (!name || !email) {
    needs('git', 'set your name and email: git config --global user.name "Your Name" and git config --global user.email "you@example.com"');
  } else {
    report('ok', 'git', `${firstLine(out).replace(/^git version /, '')}, as ${name} <${email}>`);
  }
  if (isWindows) checkGitBash();
}

// opencode.json sets "shell": "bash"; on Windows opencode runs that as the Git Bash that comes with Git for
// Windows (bin\bash.exe next to the cmd\git.exe folder), or OPENCODE_GIT_BASH_PATH.
function checkGitBash() {
  const override = process.env.OPENCODE_GIT_BASH_PATH;
  const git = firstLine(run('where', ['git']).out);
  const bash = override || (git ? path.join(git, '..', '..', 'bin', 'bash.exe') : '');
  if (bash && existsSync(bash)) report('ok', 'Git Bash', bash);
  else needs('Git Bash', 'opencode runs the agents\' commands in it: reinstall Git for Windows, or set OPENCODE_GIT_BASH_PATH to its bash.exe');
}

function checkOpenSpec() {
  let { ok, out } = run('openspec', ['--version']);
  if (!ok && install('OpenSpec CLI', 'npm', ['install', '-g', '@fission-ai/openspec@latest'])) {
    ({ ok, out } = run('openspec', ['--version']));
  }
  if (ok) report('ok', 'OpenSpec CLI', firstLine(out));
  else if (!checkOnly) needs('OpenSpec CLI', 'could not install it: npm install -g @fission-ai/openspec@latest');
}

function checkOpencode() {
  let { ok, out } = run('opencode', ['--version']);
  let version = ok ? versionOf(out) : null;
  if (!version) {
    if (install('opencode', 'npm', ['install', '-g', 'opencode-ai@latest'])) {
      ({ ok, out } = run('opencode', ['--version']));
      version = ok ? versionOf(out) : null;
    }
  } else if (!atLeast(version, MIN_OPENCODE)) {
    // `opencode upgrade` updates it the way it was installed (npm, Homebrew, the install script...).
    if (install('opencode', 'opencode', ['upgrade'], { why: `${show(MIN_OPENCODE)} or later is needed` })) {
      ({ ok, out } = run('opencode', ['--version']));
      version = ok ? versionOf(out) : null;
    }
  }
  if (!version) {
    if (!checkOnly) needs('opencode', 'could not install it: npm install -g opencode-ai@latest (or see https://opencode.ai)');
    return;
  }
  if (!atLeast(version, MIN_OPENCODE)) {
    if (!checkOnly) needs('opencode', `${show(MIN_OPENCODE)} or later is needed (found ${show(version)}): opencode upgrade`);
    return;
  }
  report('ok', 'opencode', show(version));
  checkModels();
}

function checkModels() {
  const byProvider = new Map();
  for (const model of agentModels()) {
    const provider = model.split('/')[0];
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), model]);
  }
  for (const [provider, models] of byProvider) {
    const { out } = run('opencode', ['models', provider], { timeoutMs: 60_000 });
    // eslint-disable-next-line no-control-regex
    const listed = new Set(out.split(/\r?\n/).map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').trim()));
    const absent = models.filter((model) => !listed.has(model));
    if (!absent.length) {
      report('ok', `opencode models (${provider})`, models.join(', '));
    } else {
      needs(`opencode models (${provider})`, `${absent.join(', ')} not available: sign in with \`opencode auth login\`, or update opencode (\`opencode upgrade\`); to use other models, change them with /config`);
    }
  }
}

function checkAspire() {
  let { ok, out } = run('aspire', ['--version']);
  if (!ok && install('Aspire CLI', 'dotnet', ['tool', 'install', '-g', 'Aspire.Cli'])) {
    ({ ok, out } = run('aspire', ['--version']));
    if (!ok && existsSync(path.join(os.homedir(), '.dotnet', 'tools', isWindows ? 'aspire.exe' : 'aspire'))) {
      report('ok', 'Aspire CLI', 'installed in ~/.dotnet/tools - open a new terminal so it is on your PATH');
      return;
    }
  }
  if (ok) report('ok', 'Aspire CLI', firstLine(out));
  else if (!checkOnly) needs('Aspire CLI', 'could not install it: dotnet tool install -g Aspire.Cli (or see https://aspire.dev/get-started/install-cli/)');
}

function checkAspireTemplates() {
  const listed = () => /aspire-apphost/.test(run('dotnet', ['new', 'list', 'aspire-apphost']).out);
  let ok = listed();
  if (!ok && install('Aspire project templates', 'dotnet', ['new', 'install', 'Aspire.ProjectTemplates'])) ok = listed();
  if (ok) report('ok', 'Aspire project templates');
  else if (!checkOnly) needs('Aspire project templates', 'could not install them: dotnet new install Aspire.ProjectTemplates');
}

// opencode starts Roslynk with `dnx Roslynk@<version>`, which downloads it on first use - slow enough to run
// into the server's start-up timeout. dnx looks in the NuGet global packages folder first, so fetch it there.
function checkRoslynk() {
  const command = opencodeConfig().mcp?.roslynk?.command ?? [];
  const pinned = command.map((part) => /^Roslynk@(.+)$/i.exec(part)).find(Boolean);
  if (!pinned) {
    report('skip', 'Roslynk', 'opencode.json does not pin a version; dnx fetches it when opencode starts');
    return;
  }
  const version = pinned[1];
  const folder = firstLine(run('dotnet', ['nuget', 'locals', 'global-packages', '--list']).out).replace(/^global-packages:\s*/, '');
  const packageDir = path.join(folder, 'roslynk', version.toLowerCase());
  const cached = () => existsSync(path.join(packageDir, `roslynk.${version.toLowerCase()}.nupkg.metadata`));
  if (folder && cached()) {
    report('ok', 'Roslynk', `${version}, ready for dnx`);
    return;
  }
  if (checkOnly) {
    needs('Roslynk', `${version} is not downloaded yet; run this script without --check, or opencode fetches it on first start`);
    return;
  }
  console.log(`  installing Roslynk ${version} into the NuGet cache`);
  const temp = mkdtempSync(path.join(os.tmpdir(), 'roslynk-'));
  try {
    writeFileSync(path.join(temp, 'fetch.csproj'), [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>',
      `  <ItemGroup><PackageDownload Include="Roslynk" Version="[${version}]" /></ItemGroup>`,
      '</Project>',
      '',
    ].join('\n'));
    run('dotnet', ['restore'], { cwd: temp, inherit: true, timeoutMs: 15 * 60_000 });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  if (cached()) report('ok', 'Roslynk', `${version}, ready for dnx`);
  else needs('Roslynk', `could not download ${version}; opencode will try again when it starts`);
}

function chromePath() {
  const candidates = isWindows
    ? [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]
        .filter(Boolean)
        .map((base) => path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    : isMac
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/opt/google/chrome/chrome'];
  return candidates.find((file) => existsSync(file));
}

// The debugger's browser: the Playwright MCP server (fetched by npx, as opencode.json starts it) driving
// Google Chrome, which it looks for only where Chrome's own installer puts it.
function checkPlaywright() {
  const command = opencodeConfig().mcp?.playwright?.command ?? [];
  const spec = command.find((part) => /^@playwright\/mcp(@.*)?$/.test(part)) ?? '@playwright/mcp@latest';
  if (checkOnly) {
    report('skip', 'Playwright MCP server', `${spec}, fetched by npx when opencode starts`);
  } else {
    const { ok, out } = run('npx', ['-y', spec, '--version'], { timeoutMs: 5 * 60_000 });
    if (ok) report('ok', 'Playwright MCP server', firstLine(out).replace(/^Version /, ''));
    else needs('Playwright MCP server', `npx could not fetch ${spec}: ${firstLine(out)}`);
  }

  let chrome = chromePath();
  if (!chrome && install('Google Chrome', 'npx', ['-y', 'playwright', 'install', 'chrome'], { why: 'it may ask for your password' })) {
    chrome = chromePath();
  }
  if (chrome) report('ok', 'Google Chrome', chrome);
  else if (!checkOnly) needs('Google Chrome', `install it from https://www.google.com/chrome${isMac ? ' into /Applications' : ''}`);
}

function checkContainers() {
  const podman = run('podman', ['--version']).ok;
  const docker = run('docker', ['--version']).ok;
  if (!podman && !docker) {
    const how = isWindows
      ? 'winget install --id RedHat.Podman-Desktop -e'
      : isMac
        ? 'brew install podman, then podman machine init'
        : 'sudo apt install podman, or your distribution\'s package';
    needs('Podman or Docker', `needed for databases and other resources, in the app and in its tests: ${how}`);
    return;
  }
  if (docker && run('docker', ['info'], { timeoutMs: 30_000 }).ok) {
    report('ok', 'Docker', 'running');
  } else if (podman && run('podman', ['info'], { timeoutMs: 30_000 }).ok) {
    report('ok', 'Podman', 'running');
    checkPodmanSettings();
  } else {
    const desktop = isWindows || isMac;
    const start = podman
      ? desktop ? 'podman machine start, or open Podman Desktop' : 'check `podman info`'
      : desktop ? 'start Docker Desktop' : 'start the Docker service (sudo systemctl start docker)';
    report('note', podman ? 'Podman' : 'Docker', `installed but not running: ${start}`);
  }
}

// Aspire uses Docker unless told otherwise, and Testcontainers looks only for Docker's API.
function checkPodmanSettings() {
  const env = process.env;
  if (isMac) {
    const missing = [
      env.ASPIRE_CONTAINER_RUNTIME !== 'podman' && 'export ASPIRE_CONTAINER_RUNTIME=podman',
      !env.DOCKER_HOST && 'export DOCKER_HOST="unix://$(podman machine inspect --format \'{{.ConnectionInfo.PodmanSocket.Path}}\')"',
      env.TESTCONTAINERS_RYUK_DISABLED !== 'true' && 'export TESTCONTAINERS_RYUK_DISABLED=true',
    ].filter(Boolean);
    if (missing.length) needs('Podman settings', `add to ~/.zshrc, then open a new Terminal window:\n${missing.map((line) => `               ${line}`).join('\n')}`);
  } else if (isWindows && env.ASPIRE_CONTAINER_RUNTIME !== 'podman') {
    report('note', 'Podman settings', 'set ASPIRE_CONTAINER_RUNTIME=podman (setx ASPIRE_CONTAINER_RUNTIME podman), and turn on Docker compatibility in Podman Desktop\'s settings so the tests can find it');
  }
}

function checkAzure() {
  if (run('az', ['version'], { timeoutMs: 60_000 }).ok) {
    report('ok', 'Azure CLI');
    return;
  }
  const how = isWindows
    ? 'winget install --id Microsoft.AzureCLI -e'
    : isMac
      ? 'brew install azure-cli'
      : 'https://learn.microsoft.com/cli/azure/install-azure-cli';
  report('note', 'Azure CLI', `only needed to /deploy to Azure: ${how}`);
}

const where = isWindows ? 'Windows' : isMac ? 'macOS' : isWsl ? 'Linux (WSL)' : 'Linux';
console.log(`${checkOnly ? 'Checking' : 'Installing and checking'} the tools this workflow needs (${where})\n`);

checkNode();
const hasDotnet = checkDotnet();
checkGit();
checkOpenSpec();
checkOpencode();
if (hasDotnet) {
  checkAspire();
  checkAspireTemplates();
  checkRoslynk();
} else {
  report('skip', 'Aspire CLI, Aspire project templates, Roslynk', 'they need the .NET SDK');
}
checkPlaywright();
checkContainers();
checkAzure();

console.log('');
if (attention) {
  console.log(`${attention} ${attention === 1 ? 'thing needs' : 'things need'} your attention: see the lines marked "missing" above. Run this again when ${attention === 1 ? 'it is' : 'they are'} done.`);
} else {
  console.log('Everything this workflow needs is in place.');
  console.log('Next: run `opencode`, then `/setup <Title> - <what it does>` (or, for an existing solution, see .opencode/docs/setup.md).');
}
if (installedSomething) console.log('Open a new terminal before you start opencode, so it finds what was just installed.');
process.exit(attention ? 1 : 0);

# Roslynk in the opencode workflow - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the developer and debugger agents Roslynk's read-only C# tools (navigation, references, near-instant diagnostics) through opencode, without weakening any edit boundary.

**Architecture:** One `local` MCP entry in `opencode.json` starts a pinned Roslynk through `dnx`. A global `"roslynk_*": "deny"` blocks every Roslynk tool; `developer.md` and `debugger.md` allow the 20 read-only tools by exact name. A new opencode skill teaches those two agents when to use them, and the README documents it. No custom MCP server code.

**Tech Stack:** opencode config (JSON, agent markdown with YAML frontmatter), Roslynk 2.0.0 (NuGet, run with `dnx` from the .NET 10 SDK), Node.js 24 for throwaway checks, PowerShell / Git Bash on Windows.

**Spec:** `docs/superpowers/specs/2026-10-05-roslynk-mcp-integration-design.md`

## Global Constraints

- Roslynk command, exactly: `["dnx", "Roslynk@2.0.0", "--yes", "--", "stdio"]`, with `"timeout": 60000`.
- Read-only for every agent. Only `developer` and `debugger` get Roslynk, and only these 20 tools: `open_solution`, `get_solution_status`, `reload_solution`, `find_definition`, `get_expression_info`, `get_symbol`, `get_symbol_body`, `get_members`, `search_symbols`, `multi_query`, `find_references`, `find_reads`, `find_writes`, `get_callers`, `find_implementations`, `get_type_hierarchy`, `get_diagnostics`, `get_code_actions`, `find_dead_code`, `find_dead_conditionals`.
- Never allowed for any agent: `apply_patch`, `rename_symbol`, `rename_parameter`, `change_signature`, `extract_method`, `remove_unused_usings`, `apply_code_action`, `apply_code_fix`.
- Do not change `AGENTS.md`, `GUIDE.md`, `scripts/`, `.workflow/`, `openspec/`, `.opencode/commands/`, `.opencode/config-editor/`, `.opencode/skills/vertical-slices/`, or the other four agent files.
- Agent instruction changes are additions only: no existing line in `developer.md` or `debugger.md` changes.
- Markdown files keep their line endings (this checkout: CRLF, `core.autocrlf=true`); never mix CRLF and bare LF in one file. `opencode.json` keeps its 2-space indentation.
- The check scripts are throwaway: they live in the scratchpad and are never committed.
- Approved downloads only: Roslynk 2.0.0 via `dnx`, and `opencode-ai@1.18.34` via npm. Nothing else - in particular `@playwright/mcp` must not be fetched.
- Commits stay on branch `claude/roslynk-mcp-integration-030840`, end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, and are never pushed. Never use `git stash`.

## Paths used in commands

Shell state does not persist between commands, so each command sets what it needs.

- Repository root (run every command from here): `C:/Users/Indiana.Kerrison/Documents/Projects/OpenCode-TDD/.claude/worktrees/roslynk-mcp-integration-030840`
- Scratchpad, for the throwaway checks: `S="C:/Users/INDIAN~1.KER/AppData/Local/Temp/claude/C--Users-Indiana-Kerrison-Documents-Projects-OpenCode-TDD--claude-worktrees-roslynk-mcp-integration-030840/d9f345d7-b276-4a19-b81c-54bd17322b50/scratchpad"`
- Throwaway solution: `C:/Users/Indiana.Kerrison/AppData/Local/Temp/rk smoke`. It is not in the scratchpad because Windows long paths are off on this machine (`LongPathsEnabled=0`) and the scratchpad path is too long for `obj/` folders. The space in the name is deliberate (see Review Focus).

## Review Focus

1. **`dnx` writing to stdout.** opencode reads the server's stdout as JSON-RPC, so download or banner text there would corrupt the stream. Expected: once the package is cached, stdout carries only JSON-RPC. Pinned by Task 1's second `check-live` run with `--strict`.
2. **Solution path containing a space.** Real project folders often have spaces. Expected: `open_solution` and `get_diagnostics` work. Pinned by Task 1's throwaway solution in `rk smoke`.
3. **Mixed line endings in edited markdown.** An edit that inserts LF lines into a CRLF file produces noisy diffs and fragile frontmatter. Expected: each file stays consistent. Pinned by `assertConsistentEndings` in Tasks 1, 2 and 3.
4. **Port 6502 already taken.** The README tells people to set `Roslynk__Port`. Expected: the bridge and the daemon both honour it. Pinned by Task 3's `check-live` run with `Roslynk__Port=6517`.
5. **An invalid skill frontmatter.** opencode silently ignores a skill whose `name` does not match its folder or breaks the naming rules. Expected: the skill loads. Pinned by Task 2's `check-skill` name and description checks, and by Task 4's opencode skill listing.

---

### Task 0: Commit the design documents

**Files:**
- Commit: `docs/superpowers/specs/2026-10-05-roslynk-mcp-integration-design.md`, `docs/superpowers/plans/2026-10-05-roslynk-mcp-integration.md`

- [ ] **Step 1: Commit**

```bash
cd "C:/Users/Indiana.Kerrison/Documents/Projects/OpenCode-TDD/.claude/worktrees/roslynk-mcp-integration-030840" && git add docs/superpowers && git commit -m "Add Roslynk integration design and plan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: one commit with the two files.

---

### Task 1: Wire Roslynk into opencode, read-only, for developer and debugger

**Files:**
- Modify: `opencode.json` (the `mcp` block and the end of the `permission` block)
- Modify: `.opencode/agents/developer.md` (frontmatter only, before `task: deny`)
- Modify: `.opencode/agents/debugger.md` (frontmatter only, before `task: deny`)
- Test (throwaway): `$S/roslynk-lists.mjs`, `$S/check-config.mjs`, `$S/check-live.mjs`

**Interfaces:**
- Produces: `$S/roslynk-lists.mjs` exporting `COMMAND`, `READ_ONLY`, `WRITE`, `UPSTREAM_SKILL`, `frontmatterLines(file)`, `assertConsistentEndings(file)` and `deletedSinceMain(file)`, which Tasks 2 and 3 import. `$S/check-live.mjs "<solution dir>" [--strict]`, which Task 3 reruns with `Roslynk__Port`.
- Produces: the daemon's process name (expected `Morris.Roslynk.Mcp`), recorded in Step 9 for Task 3's README stop command.

- [ ] **Step 1: Write the shared helper**

Create `$S/roslynk-lists.mjs`:

```js
// Shared by the throwaway Roslynk checks. Spec: docs/superpowers/specs/2026-10-05-roslynk-mcp-integration-design.md
// Run every check from the repository root.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

export const COMMAND = ['dnx', 'Roslynk@2.0.0', '--yes', '--', 'stdio'];

export const READ_ONLY = [
  'open_solution', 'get_solution_status', 'reload_solution',
  'find_definition', 'get_expression_info', 'get_symbol', 'get_symbol_body', 'get_members', 'search_symbols', 'multi_query',
  'find_references', 'find_reads', 'find_writes', 'get_callers', 'find_implementations', 'get_type_hierarchy',
  'get_diagnostics', 'get_code_actions', 'find_dead_code', 'find_dead_conditionals',
];

export const WRITE = [
  'apply_patch', 'rename_symbol', 'rename_parameter', 'change_signature',
  'extract_method', 'remove_unused_usings', 'apply_code_action', 'apply_code_fix',
];

export const UPSTREAM_SKILL = 'https://github.com/mrpmorris/Roslynk/tree/07b64a6eaaf1b3af946ba1b3b8d92c1978168b96/skills/roslynk';

/** The lines between a markdown file's opening and closing `---`. */
export function frontmatterLines(file) {
  const text = readFileSync(file, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  assert.ok(match, `${file}: has a frontmatter block`);
  return match[1].split(/\r?\n/);
}

/** Fails when a file mixes CRLF and bare LF line endings. */
export function assertConsistentEndings(file) {
  const text = readFileSync(file, 'utf8');
  const lf = (text.match(/\n/g) ?? []).length;
  const crlf = (text.match(/\r\n/g) ?? []).length;
  assert.ok(crlf === 0 || crlf === lf, `${file}: mixed line endings (${crlf} CRLF, ${lf - crlf} bare LF)`);
}

/** Lines deleted from a file since main, per `git diff --numstat` (line endings normalised by git). */
export function deletedSinceMain(file) {
  const out = execFileSync('git', ['diff', '--numstat', 'main', '--', file], { encoding: 'utf8' }).trim();
  return out ? Number(out.split('\t')[1]) : 0;
}
```

- [ ] **Step 2: Write the config check**

Create `$S/check-config.mjs`:

```js
// Throwaway: opencode.json and the agent frontmatter wire Roslynk read-only for developer and debugger only.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { COMMAND, READ_ONLY, WRITE, frontmatterLines, assertConsistentEndings, deletedSinceMain } from './roslynk-lists.mjs';

const cfg = JSON.parse(readFileSync('opencode.json', 'utf8'));
assert.deepEqual(cfg.mcp?.roslynk, { type: 'local', command: COMMAND, enabled: true, timeout: 60000 }, 'opencode.json: mcp.roslynk');
assert.equal(cfg.permission['roslynk_*'], 'deny', 'opencode.json: global roslynk_* deny');
assert.equal(cfg.permission.skill?.roslynk, 'deny', 'opencode.json: global roslynk skill deny');
assert.equal(cfg.permission.skill?.['openspec-*'], 'deny', 'opencode.json: openspec skill deny kept');
assert.equal(cfg.permission['playwright_*'], 'deny', 'opencode.json: playwright deny kept');
assert.equal(cfg.permission['aspire_*'], 'deny', 'opencode.json: aspire deny kept');
assert.equal(deletedSinceMain('opencode.json'), 3, 'opencode.json: only the three lines that gain a trailing comma change');

const roslynkLines = (lines) => lines.filter((line) => line.includes('roslynk'));

for (const agent of ['developer', 'debugger']) {
  const file = `.opencode/agents/${agent}.md`;
  const lines = frontmatterLines(file);
  for (const tool of READ_ONLY) assert.ok(lines.includes(`  "roslynk_${tool}": allow`), `${agent}: allows roslynk_${tool}`);
  for (const tool of WRITE) assert.ok(!lines.some((line) => line.includes(`roslynk_${tool}`)), `${agent}: never mentions roslynk_${tool}`);
  assert.ok(!lines.some((line) => line.includes('roslynk_*')), `${agent}: no roslynk_* wildcard`);
  const skillAt = lines.indexOf('  skill:');
  assert.ok(skillAt >= 0 && lines[skillAt + 1] === '    "roslynk": allow', `${agent}: allows the roslynk skill`);
  assert.equal(roslynkLines(lines).length, READ_ONLY.length + 1, `${agent}: exactly the 20 tools and the skill`);
  assertConsistentEndings(file);
  assert.equal(deletedSinceMain(file), 0, `${agent}: additions only`);
}

for (const agent of ['senior-dev', 'test-writer', 'test-reviewer', 'platform']) {
  assert.deepEqual(roslynkLines(frontmatterLines(`.opencode/agents/${agent}.md`)), [], `${agent}: no roslynk permissions`);
}

console.log('check-config: OK');
```

- [ ] **Step 3: Write the live check**

Create `$S/check-live.mjs`:

```js
// Throwaway: start Roslynk exactly as opencode.json says, check its tool list against the allowlist,
// and open a tiny solution. Usage: node check-live.mjs "<solution dir>" [--strict]
// --strict fails if anything other than JSON-RPC appears on stdout (use once the package is cached).
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';
import { READ_ONLY, WRITE } from './roslynk-lists.mjs';

const solutionDir = process.argv[2];
const strict = process.argv.includes('--strict');
assert.ok(solutionDir, 'usage: node check-live.mjs "<solution dir>" [--strict]');
const port = Number(process.env.Roslynk__Port ?? 6502);

const cfg = JSON.parse(readFileSync('opencode.json', 'utf8'));
assert.ok(cfg.mcp?.roslynk, 'opencode.json has mcp.roslynk');
const [cmd, ...args] = cfg.mcp.roslynk.command;

// A throwaway class library in a folder whose path contains a space.
const slnx = path.resolve(solutionDir, 'Tiny.slnx');
if (!existsSync(slnx)) {
  mkdirSync(solutionDir, { recursive: true });
  const dotnet = (...a) => execFileSync('dotnet', a, { cwd: solutionDir, stdio: 'inherit' });
  dotnet('new', 'classlib', '-n', 'Tiny', '-o', 'Tiny');
  dotnet('new', 'sln', '-n', 'Tiny', '--format', 'slnx');
  dotnet('sln', 'Tiny.slnx', 'add', path.join('Tiny', 'Tiny.csproj'));
}

// dnx is dnx.cmd on Windows, which needs a shell; on Linux it runs directly, as opencode will run it.
const child = spawn(cmd, args, { shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'inherit'] });
const nonJson = [];
const pending = new Map();
let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      nonJson.push(line);
      continue;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

let nextId = 1;
function request(method, params, timeoutMs = 180_000) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method}: no reply within ${timeoutMs} ms`)), timeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
      else resolve(message.result);
    });
  });
}
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
const callTool = async (name, toolArgs) =>
  (await request('tools/call', { name, arguments: toolArgs })).content.map((c) => c.text ?? '').join('\n');

async function main() {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'roslynk-smoke', version: '0' },
  });
  console.log(`server: ${init.serverInfo?.name} ${init.serverInfo?.version}`);
  notify('notifications/initialized', {});

  const tools = [];
  let cursor;
  do {
    const page = await request('tools/list', cursor ? { cursor } : {});
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.deepEqual([...byName.keys()].sort(), [...READ_ONLY, ...WRITE].sort(), 'tools are exactly the 20 read-only and 8 write tools');
  for (const name of READ_ONLY) assert.equal(byName.get(name).annotations?.readOnlyHint, true, `${name} is annotated read-only`);
  for (const name of WRITE) assert.notEqual(byName.get(name).annotations?.readOnlyHint, true, `${name} is not annotated read-only`);
  console.log(`tools: ${tools.length}, read-only annotations match the allowlist`);

  await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => { socket.end(); resolve(); });
    socket.on('error', reject);
  });
  console.log(`daemon listening on 127.0.0.1:${port}`);

  const opened = await callTool('open_solution', { solutionPath: slnx });
  const solutionId = /solutionId=(\S+)/.exec(opened)?.[1];
  assert.ok(solutionId, `open_solution returned a solutionId:\n${opened}`);

  let diagnostics;
  const deadline = Date.now() + 180_000;
  do {
    diagnostics = await callTool('get_diagnostics', { solutionId });
    if (!diagnostics.includes('error=Indexing')) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  assert.match(diagnostics, /errors=0\b/, `get_diagnostics on a fresh class library reports no errors:\n${diagnostics}`);
  console.log(`diagnostics: ${diagnostics.split('\n')[0]}`);

  if (nonJson.length) console.warn(`stdout carried ${nonJson.length} non-JSON line(s):\n  ${nonJson.join('\n  ')}`);
  if (strict) assert.deepEqual(nonJson, [], 'stdout carried only JSON-RPC');
  console.log('check-live: OK');
}

main()
  .then(() => { child.stdin.end(); child.kill(); process.exit(0); })
  .catch((error) => { console.error(error.message); child.stdin.end(); child.kill(); process.exit(1); });
```

- [ ] **Step 4: Run both checks to verify they fail**

```bash
cd "C:/Users/Indiana.Kerrison/Documents/Projects/OpenCode-TDD/.claude/worktrees/roslynk-mcp-integration-030840" && S="C:/Users/INDIAN~1.KER/AppData/Local/Temp/claude/C--Users-Indiana-Kerrison-Documents-Projects-OpenCode-TDD--claude-worktrees-roslynk-mcp-integration-030840/d9f345d7-b276-4a19-b81c-54bd17322b50/scratchpad"; node "$S/check-config.mjs"; node "$S/check-live.mjs" "C:/Users/Indiana.Kerrison/AppData/Local/Temp/rk smoke"
```

Expected: `check-config` fails with `opencode.json: mcp.roslynk`; `check-live` fails with `opencode.json has mcp.roslynk`. No download has happened yet.

- [ ] **Step 5: Add the MCP entry to `opencode.json`**

Replace:

```json
      "command": ["aspire", "agent", "mcp", "--non-interactive", "--nologo"],
      "enabled": true
    }
  },
```

with:

```json
      "command": ["aspire", "agent", "mcp", "--non-interactive", "--nologo"],
      "enabled": true
    },
    "roslynk": {
      "type": "local",
      "command": ["dnx", "Roslynk@2.0.0", "--yes", "--", "stdio"],
      "enabled": true,
      "timeout": 60000
    }
  },
```

- [ ] **Step 6: Add the global denies to `opencode.json`**

Replace:

```json
    "skill": {
      "openspec-*": "deny"
    },
    "playwright_*": "deny",
    "aspire_*": "deny"
  }
```

with:

```json
    "skill": {
      "openspec-*": "deny",
      "roslynk": "deny"
    },
    "playwright_*": "deny",
    "aspire_*": "deny",
    "roslynk_*": "deny"
  }
```

- [ ] **Step 7: Allow the read-only tools in `developer.md` and `debugger.md`**

In `.opencode/agents/developer.md`, replace:

```yaml
    "*<<*": deny
  task: deny
```

In `.opencode/agents/debugger.md`, replace:

```yaml
  "aspire_*": allow
  task: deny
```

In each file, keep the first line of the matched text as it is and put this block between it and `  task: deny`:

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

So `developer.md` reads `    "*<<*": deny`, then the block, then `  task: deny`, and `debugger.md` reads `  "aspire_*": allow`, then the block, then `  task: deny`.

- [ ] **Step 8: Run both checks to verify they pass (first run downloads Roslynk 2.0.0)**

```bash
cd "C:/Users/Indiana.Kerrison/Documents/Projects/OpenCode-TDD/.claude/worktrees/roslynk-mcp-integration-030840" && S="C:/Users/INDIAN~1.KER/AppData/Local/Temp/claude/C--Users-Indiana-Kerrison-Documents-Projects-OpenCode-TDD--claude-worktrees-roslynk-mcp-integration-030840/d9f345d7-b276-4a19-b81c-54bd17322b50/scratchpad"; node "$S/check-config.mjs" && node "$S/check-live.mjs" "C:/Users/Indiana.Kerrison/AppData/Local/Temp/rk smoke" && node "$S/check-live.mjs" "C:/Users/Indiana.Kerrison/AppData/Local/Temp/rk smoke" --strict
```

Use a 10-minute timeout. Expected: `check-config: OK`, then two `check-live: OK` runs, each showing `tools: 28`, `daemon listening on 127.0.0.1:6502` and a diagnostics header with `errors=0`. The first run may warn about non-JSON stdout lines (download output). The `--strict` run must not.

If `dnx` rejects `Roslynk@2.0.0` (an argument or "package not found" error), stop and report it. The fallback form is `["dnx", "Roslynk", "--version", "2.0.0", "--yes", "--", "stdio"]`, but changing the command changes the approved spec, so the human decides.

If the first `check-live` run warns about non-JSON stdout lines, record them for the final report: opencode will see the same lines the first time a project uses Roslynk.

- [ ] **Step 9: Record the daemon's process**

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'Roslynk' } | Select-Object ProcessId, Name, CommandLine | Format-List
```

Expected: a `dotnet.exe` process whose command line ends in `Morris.Roslynk.Mcp.dll`. If the name differs, use the observed name in Task 3's stop command and in `check-readme.mjs`. Leave it running: Task 3 needs it, and Task 4 stops it.

- [ ] **Step 10: Commit**

```bash
cd "C:/Users/Indiana.Kerrison/Documents/Projects/OpenCode-TDD/.claude/worktrees/roslynk-mcp-integration-030840" && git add opencode.json .opencode/agents/developer.md .opencode/agents/debugger.md && git commit -m "Wire Roslynk 2.0.0 into opencode, read-only, for developer and debugger

Every roslynk_* tool is denied globally; developer and debugger allow
its 20 read-only tools by name. Its 8 write tools stay denied for every
agent because they write straight to disk and would bypass the
per-agent edit permissions and the test lock.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The roslynk skill and the two agents' instructions

**Files:**
- Create: `.opencode/skills/roslynk/SKILL.md`
- Modify: `.opencode/agents/developer.md` (one new step after "3. Run the slice's acceptance tests and confirm they fail.")
- Modify: `.opencode/agents/debugger.md` (one new bullet after the "**The code**" bullet under "Your tools")
- Test (throwaway): `$S/check-skill.mjs`

**Interfaces:**
- Consumes: `$S/roslynk-lists.mjs` from Task 1 (`WRITE`, `UPSTREAM_SKILL`, `frontmatterLines`, `assertConsistentEndings`, `deletedSinceMain`).
- Produces: skill name `roslynk`, which matches the `skill:` permission added in Task 1.

- [ ] **Step 1: Write the skill check**

Create `$S/check-skill.mjs`:

```js
// Throwaway: the roslynk skill is valid for opencode, matches this workflow, and both agents point to it.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { WRITE, UPSTREAM_SKILL, frontmatterLines, assertConsistentEndings, deletedSinceMain } from './roslynk-lists.mjs';

const file = '.opencode/skills/roslynk/SKILL.md';
const text = readFileSync(file, 'utf8');
assertConsistentEndings(file);

const fm = frontmatterLines(file);
const name = fm.find((line) => line.startsWith('name: '))?.slice('name: '.length);
const description = fm.find((line) => line.startsWith('description: '))?.slice('description: '.length);
assert.equal(name, 'roslynk', 'skill name matches its folder');
assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/, 'skill name follows opencode naming rules');
assert.ok(description && description.length <= 1024, `description is 1-1024 characters (got ${description?.length})`);
assert.ok(!description.includes(': '), 'description is a plain YAML scalar (no ": ")');

const body = text.slice(text.indexOf('\n---', 3) + 4);
const named = ['open_solution', 'get_solution_status', 'get_diagnostics', 'find_references', 'get_callers',
  'get_symbol_body', 'find_definition', 'get_expression_info', 'multi_query', 'reload_solution'];
for (const tool of named) assert.ok(body.includes(`roslynk_${tool}`), `skill names roslynk_${tool}`);
for (const tool of WRITE) assert.ok(!text.includes(tool), `skill never names the write tool ${tool}`);
assert.ok(!text.includes('mcp__roslynk__'), "skill uses opencode's tool names, not Claude Code's");
assert.ok(body.includes('dotnet test'), 'skill keeps dotnet test as the proof');
assert.ok(body.includes(UPSTREAM_SKILL), 'skill links the pinned upstream skill');
assert.ok(body.includes('## If Roslynk is unavailable'), 'skill says what to do when Roslynk is unavailable');
assert.ok(body.includes('AGENTS.md'), 'skill points to the boundary rule');

const developer = readFileSync('.opencode/agents/developer.md', 'utf8');
const debuggerText = readFileSync('.opencode/agents/debugger.md', 'utf8');
assert.ok(developer.includes('4. Load the **roslynk** skill'), 'developer.md: new step 4 points to the skill');
assert.ok(debuggerText.includes('- **Roslynk**:') && debuggerText.includes('Load the **roslynk** skill'), 'debugger.md: Roslynk tools bullet');
for (const agent of ['developer', 'debugger']) {
  const agentFile = `.opencode/agents/${agent}.md`;
  assertConsistentEndings(agentFile);
  assert.equal(deletedSinceMain(agentFile), 0, `${agent}: additions only`);
}

console.log('check-skill: OK');
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "C:/Users/Indiana.Kerrison/Documents/Projects/OpenCode-TDD/.claude/worktrees/roslynk-mcp-integration-030840" && S="C:/Users/INDIAN~1.KER/AppData/Local/Temp/claude/C--Users-Indiana-Kerrison-Documents-Projects-OpenCode-TDD--claude-worktrees-roslynk-mcp-integration-030840/d9f345d7-b276-4a19-b81c-54bd17322b50/scratchpad"; node "$S/check-skill.mjs"
```

Expected: FAIL with `ENOENT` for `.opencode/skills/roslynk/SKILL.md`.

- [ ] **Step 3: Write the skill**

Create `.opencode/skills/roslynk/SKILL.md`:

````markdown
---
name: roslynk
description: How to use the Roslynk tools (roslynk_*) - a live Roslyn compilation of this solution - to find C# code and check that it compiles, faster and more accurately than grep, whole-file reads or dotnet build. Load before reading, tracing or changing C# code when the roslynk_* tools are available.
---

# Roslynk

Roslynk holds a live Roslyn compilation of the solution. It answers "where is this defined?", "who calls it?", "what uses it?" and "does it compile?" from the compiler's own model, so it sees partial classes, generated code and `#if` branches, and never matches a name inside a comment or a string. Grep does none of that.

In this workflow Roslynk is **read-only**: you get its navigation and diagnostics tools, never its editing tools. Each tool's exact parameters and output are in its own description; this skill covers when to use which. Upstream's fuller guide is written for Claude Code, whose tool names differ: https://github.com/mrpmorris/Roslynk/tree/07b64a6eaaf1b3af946ba1b3b8d92c1978168b96/skills/roslynk

## Open the solution first
1. Find the solution file in the repository root (`ls *.slnx *.sln`). No solution yet means no Roslynk - use your other tools.
2. Call `roslynk_open_solution` with its **absolute** path: the working directory from your environment plus the file name. Keep the `solutionId` it returns; every other tool needs it.
3. It loads in the background. While it does, tools return `error=Indexing`: wait a second and retry, or poll `roslynk_get_solution_status`. Loading takes from a few seconds to a minute.

## Which tool
| You want to... | Use |
|---|---|
| know whether it compiles, and why not | `roslynk_get_diagnostics` |
| jump from a usage to its declaration | `roslynk_find_definition` (file, line, column) |
| see every usage of a type or member | `roslynk_find_references` |
| see who calls a method | `roslynk_get_callers` |
| see where a field, property or parameter is read or written | `roslynk_find_reads`, `roslynk_find_writes` |
| find implementations or derived types | `roslynk_find_implementations`, `roslynk_get_type_hierarchy` |
| read one member without reading the whole file | `roslynk_get_symbol_body` |
| list a type's members | `roslynk_get_members` |
| find a symbol by part of its name | `roslynk_search_symbols` |
| know what an expression is (the type behind `var`, the overload chosen, nullability) | `roslynk_get_expression_info` |
| ask several of these at once | `roslynk_multi_query` |

Before changing a type or member, ask what depends on it in one `roslynk_multi_query`: `get_symbol`, `find_references`, `get_callers`, `find_implementations` and `get_type_hierarchy`, each pointed at it. The answers come from one snapshot, so they agree with each other.

Names are fully qualified (`Namespace.Type.Member`, with a parameter list such as `(int)` to pick an overload). On `error=Ambiguous` or `error=NotFound`, copy one of the `candidate=` lines back verbatim. On `truncated=Y`, raise `maxResults`. Query again after any edit rather than reusing an earlier answer.

## Compile checks
`roslynk_get_diagnostics` replaces waiting for `dotnet build` while you work. A bare call returns counts (`errors=`, `warnings=`); when they are not zero, call it again with `includeErrors=true` (or `includeWarnings=true`) for the details. `roslynk_get_code_actions` lists the fixes Roslyn offers at a position - treat them as suggestions.

It does not run tests. `dotnet test` is still the proof: run it before you report, and report its results.

## Editing
Roslynk's editing tools are not available to you. Make every change with your normal edit tool; Roslynk's file watcher picks it up, so your next query sees it. Apply a suggested code action by hand.

A denied tool is a boundary, exactly like a denied edit (AGENTS.md): never try to reach the same result another way.

## Reload
Call `roslynk_reload_solution` only when answers are clearly out of date even after querying again - for example after a package restore or a branch switch. The file watcher handles ordinary edits.

## If Roslynk is unavailable
If the `roslynk_*` tools are missing, fail to start, or keep returning errors other than `Indexing`, carry on with your other tools (file reads, grep, `dotnet build`) and say in your report that Roslynk was unavailable. Never stop work because of it.
````

- [ ] **Step 4: Add step 4 to `developer.md`**

Replace:

```markdown
3. Run the slice's acceptance tests and confirm they fail.
```

with:

```markdown
3. Run the slice's acceptance tests and confirm they fail.
4. Load the **roslynk** skill and open the solution with it: use Roslynk to find code and to check that it compiles while you work. `dotnet test` stays the proof.
```

- [ ] **Step 5: Add the Roslynk bullet to `debugger.md`**

Replace:

```markdown
- **The code**: read any file. `.opencode/skills/vertical-slices/scripts/overview.sh slices` maps routes to slices. `git log -p -- <path>`, `git show` and `git blame` show what changed recently.
```

with:

```markdown
- **The code**: read any file. `.opencode/skills/vertical-slices/scripts/overview.sh slices` maps routes to slices. `git log -p -- <path>`, `git show` and `git blame` show what changed recently.
- **Roslynk**: compiler-backed, read-only navigation over the solution (the `roslynk_*` tools). Trace from the endpoint to the failure with `roslynk_find_definition`, `roslynk_get_callers` and `roslynk_find_references`, and read members with `roslynk_get_symbol_body` instead of whole files. Load the **roslynk** skill first.
```

- [ ] **Step 6: Run the skill and config checks to verify they pass**

```bash
cd "C:/Users/Indiana.Kerrison/Documents/Projects/OpenCode-TDD/.claude/worktrees/roslynk-mcp-integration-030840" && S="C:/Users/INDIAN~1.KER/AppData/Local/Temp/claude/C--Users-Indiana-Kerrison-Documents-Projects-OpenCode-TDD--claude-worktrees-roslynk-mcp-integration-030840/d9f345d7-b276-4a19-b81c-54bd17322b50/scratchpad"; node "$S/check-skill.mjs" && node "$S/check-config.mjs"
```

Expected: `check-skill: OK` and `check-config: OK`.

- [ ] **Step 7: Commit**

```bash
cd "C:/Users/Indiana.Kerrison/Documents/Projects/OpenCode-TDD/.claude/worktrees/roslynk-mcp-integration-030840" && git add .opencode/skills/roslynk/SKILL.md .opencode/agents/developer.md .opencode/agents/debugger.md && git commit -m "Add the roslynk skill and point developer and debugger to it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Document Roslynk in the README

**Files:**
- Modify: `README.md` (prerequisites line 53, new section before `## Commands`, enforcement table, layout block, Customising list)
- Test (throwaway): `$S/check-readme.mjs`

**Interfaces:**
- Consumes: `$S/roslynk-lists.mjs` (`assertConsistentEndings`, `deletedSinceMain`) and `$S/check-live.mjs` from Task 1, and the daemon process name recorded in Task 1 Step 9 (expected `Morris.Roslynk.Mcp`).

- [ ] **Step 1: Write the README check**

Create `$S/check-readme.mjs`:

```js
// Throwaway: the README documents Roslynk as built, with the version taken from opencode.json.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { assertConsistentEndings, deletedSinceMain } from './roslynk-lists.mjs';

const readme = readFileSync('README.md', 'utf8');
assertConsistentEndings('README.md');

const cfg = JSON.parse(readFileSync('opencode.json', 'utf8'));
const version = /@(.+)$/.exec(cfg.mcp.roslynk.command[1])[1];

assert.ok(readme.includes('## Roslynk, read-only'), 'README: Roslynk section');
assert.ok(readme.includes(`Roslynk ${version}`), `README: names the pinned version ${version}`);
for (const text of ['localhost:6502', 'Roslynk__Port', 'daemon.log', 'pkill -f Morris.Roslynk.Mcp', '.opencode/skills/roslynk/', '`dnx`']) {
  assert.ok(readme.includes(text), `README: mentions ${text}`);
}
assert.ok(!readme.includes('MCP servers (debugger only)'), 'README: old layout comment replaced');
assert.ok(readme.includes('MCP servers, each limited to the agents that need it'), 'README: new layout comment');
assert.match(readme, /^\| Roslynk cannot change files \| .*8 write tools.* \|\r?$/m, 'README: enforcement table row');
assert.ok(readme.includes('**Upgrading Roslynk:**'), 'README: upgrade steps under Customising');
assert.equal(deletedSinceMain('README.md'), 2, 'README: only the prerequisites line and the layout comment change');

console.log('check-readme: OK');
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "C:/Users/Indiana.Kerrison/Documents/Projects/OpenCode-TDD/.claude/worktrees/roslynk-mcp-integration-030840" && S="C:/Users/INDIAN~1.KER/AppData/Local/Temp/claude/C--Users-Indiana-Kerrison-Documents-Projects-OpenCode-TDD--claude-worktrees-roslynk-mcp-integration-030840/d9f345d7-b276-4a19-b81c-54bd17322b50/scratchpad"; node "$S/check-readme.mjs"
```

Expected: FAIL with `README: Roslynk section`.

- [ ] **Step 3: Prerequisites**

Replace:

```markdown
- .NET SDK 10 or later
```

with:

```markdown
- .NET SDK 10 or later (it includes `dnx`, which downloads Roslynk the first time an agent uses it)
```

- [ ] **Step 4: New section before `## Commands`**

Replace:

```markdown
- The browser and Aspire MCP tools are denied to every agent except the debugger.

## Commands
```

with:

```markdown
- The browser and Aspire MCP tools are denied to every agent except the debugger.

## Roslynk, read-only
[Roslynk](https://github.com/mrpmorris/Roslynk) (MIT) gives the developer and the debugger a live Roslyn compilation of the solution: go to definition, find references and callers, read a single member, and compile errors near-instantly instead of after a full `dotnet build`. `opencode.json` pins Roslynk 2.0.0 and starts it through `dnx`, so there is nothing to install.
- **Read-only.** `opencode.json` denies every `roslynk_*` tool; `developer.md` and `debugger.md` allow its 20 read-only tools by name. Its 8 editing tools (`apply_patch`, `rename_symbol`, `rename_parameter`, `change_signature`, `extract_method`, `remove_unused_usings`, `apply_code_action`, `apply_code_fix`) write straight to disk and could reach the tests, the lock and the workflow files, so no agent gets them. Edits still go through each agent's own edit permissions.
- **A shared background process.** The first agent to use Roslynk starts a daemon on `localhost:6502` (loopback only, no sign-in) that later sessions share. It unloads a solution after 30 idle minutes but keeps running after opencode exits. Its log is `~/.local/share/Roslynk/daemon.log`; stop it with `pkill -f Morris.Roslynk.Mcp`.
- **Port 6502 taken?** Give the `roslynk` entry in `opencode.json` its own port: `"environment": { "Roslynk__Port": "6517" }`.
- **Not available?** The agents carry on with their usual tools and say so in their report.

## Commands
```

- [ ] **Step 5: Enforcement table row**

Replace:

```markdown
| The workflow cannot be rewritten by the agents | no agent can edit `.opencode/`, `opencode.json`, `scripts/`, `.workflow/`, `AGENTS.md` or `openspec/schemas/` |
```

with:

```markdown
| The workflow cannot be rewritten by the agents | no agent can edit `.opencode/`, `opencode.json`, `scripts/`, `.workflow/`, `AGENTS.md` or `openspec/schemas/` |
| Roslynk cannot change files | its 8 write tools are denied to every agent; only developer and debugger get its read-only tools |
```

- [ ] **Step 6: Layout block**

Replace:

```text
opencode.json                     default agent, MCP servers (debugger only), global guard rails
```

with:

```text
opencode.json                     default agent, MCP servers, each limited to the agents that need it; global guard rails
```

Then replace:

```text
.opencode/skills/vertical-slices/ examples, platform patterns, the overview command
```

with:

```text
.opencode/skills/vertical-slices/ examples, platform patterns, the overview command
.opencode/skills/roslynk/         when and how the developer and debugger use Roslynk
```

- [ ] **Step 7: Customising**

Replace:

```markdown
- **Weak-test detection:** Stryker.NET (Apache-2.0) mutation testing can be added to `scripts/verify.sh`.
```

with:

```markdown
- **Weak-test detection:** Stryker.NET (Apache-2.0) mutation testing can be added to `scripts/verify.sh`.
- **Upgrading Roslynk:** change the version in the `roslynk` command in `opencode.json` and read its release notes. Compare its tool list with the allowlists in `developer.md` and `debugger.md` - allow only tools it marks read-only - then update `.opencode/skills/roslynk/SKILL.md` to match.
```

- [ ] **Step 8: Run the README check to verify it passes**

```bash
cd "C:/Users/Indiana.Kerrison/Documents/Projects/OpenCode-TDD/.claude/worktrees/roslynk-mcp-integration-030840" && S="C:/Users/INDIAN~1.KER/AppData/Local/Temp/claude/C--Users-Indiana-Kerrison-Documents-Projects-OpenCode-TDD--claude-worktrees-roslynk-mcp-integration-030840/d9f345d7-b276-4a19-b81c-54bd17322b50/scratchpad"; node "$S/check-readme.mjs"
```

Expected: `check-readme: OK`.

- [ ] **Step 9: Prove the README's port advice works**

```bash
cd "C:/Users/Indiana.Kerrison/Documents/Projects/OpenCode-TDD/.claude/worktrees/roslynk-mcp-integration-030840" && S="C:/Users/INDIAN~1.KER/AppData/Local/Temp/claude/C--Users-Indiana-Kerrison-Documents-Projects-OpenCode-TDD--claude-worktrees-roslynk-mcp-integration-030840/d9f345d7-b276-4a19-b81c-54bd17322b50/scratchpad"; Roslynk__Port=6517 node "$S/check-live.mjs" "C:/Users/Indiana.Kerrison/AppData/Local/Temp/rk smoke" --strict
```

Use a 5-minute timeout. Expected: `daemon listening on 127.0.0.1:6517` and `check-live: OK`. A second daemon now runs on 6517; Task 4 stops it.

- [ ] **Step 10: Commit**

```bash
cd "C:/Users/Indiana.Kerrison/Documents/Projects/OpenCode-TDD/.claude/worktrees/roslynk-mcp-integration-030840" && git add README.md && git commit -m "Document Roslynk: read-only tools, shared daemon, upgrades

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Whole-branch verification, including opencode itself

**Files:**
- No repository changes expected. If a check fails, fix the file that owns the problem, rerun every check, and commit the fix with a message that says what it fixes.

**Interfaces:**
- Consumes: all check scripts and the committed files from Tasks 1-3.

- [ ] **Step 1: Rerun every throwaway check**

```bash
cd "C:/Users/Indiana.Kerrison/Documents/Projects/OpenCode-TDD/.claude/worktrees/roslynk-mcp-integration-030840" && S="C:/Users/INDIAN~1.KER/AppData/Local/Temp/claude/C--Users-Indiana-Kerrison-Documents-Projects-OpenCode-TDD--claude-worktrees-roslynk-mcp-integration-030840/d9f345d7-b276-4a19-b81c-54bd17322b50/scratchpad"; node "$S/check-config.mjs" && node "$S/check-skill.mjs" && node "$S/check-readme.mjs"
```

Expected: three `OK` lines.

- [ ] **Step 2: Config editor tests**

```bash
cd "C:/Users/Indiana.Kerrison/Documents/Projects/OpenCode-TDD/.claude/worktrees/roslynk-mcp-integration-030840" && node --test .opencode/config-editor/test/
```

Expected: all tests pass (the browser test may be reported as skipped when the `playwright` package is not found). Its helpers copy the real `opencode.json` and agent files, so this catches broken JSON or frontmatter.

- [ ] **Step 3: Files that must not change**

```bash
cd "C:/Users/Indiana.Kerrison/Documents/Projects/OpenCode-TDD/.claude/worktrees/roslynk-mcp-integration-030840" && git diff --stat main -- AGENTS.md GUIDE.md scripts .workflow openspec .opencode/commands .opencode/config-editor .opencode/skills/vertical-slices .opencode/agents/senior-dev.md .opencode/agents/test-writer.md .opencode/agents/test-reviewer.md .opencode/agents/platform.md && git diff --quiet main -- AGENTS.md GUIDE.md scripts .workflow openspec .opencode/commands .opencode/config-editor .opencode/skills/vertical-slices .opencode/agents/senior-dev.md .opencode/agents/test-writer.md .opencode/agents/test-reviewer.md .opencode/agents/platform.md && echo "untouched: OK"; git diff --stat main
```

Expected: `untouched: OK`. The final overall `--stat` lists only `opencode.json`, `README.md`, `.opencode/agents/developer.md`, `.opencode/agents/debugger.md`, `.opencode/skills/roslynk/SKILL.md` and the two files under `docs/superpowers/`.

- [ ] **Step 4: Install opencode (approved download)**

```powershell
npm install -g opencode-ai@1.18.34; opencode --version
```

Expected: `1.18.34`.

- [ ] **Step 5: Find opencode's debug commands**

```powershell
opencode debug --help
```

Record which of `config`, `agent` and `skill` exist. Steps 6, 8 and 9 use them only if they do.

- [ ] **Step 6: Confirm the other MCP servers are switched off before anything connects**

`opencode mcp list` connects to every enabled server, and the playwright entry would download `@playwright/mcp`, which is not approved. `OPENCODE_CONFIG_CONTENT` merges inline config over the project's, so it can switch playwright and aspire off for this check without touching `opencode.json`.

```powershell
$env:OPENCODE_CONFIG_CONTENT = '{"mcp":{"playwright":{"type":"local","command":["npx"],"enabled":false},"aspire":{"type":"local","command":["aspire"],"enabled":false}}}'; opencode debug config
```

Expected: the merged config shows `playwright` and `aspire` with `enabled: false`, the `roslynk` entry exactly as committed, and the `roslynk_*` and `skill` permissions.

If `opencode debug config` does not exist, or its output does not show playwright disabled, STOP and ask the human before Step 7.

- [ ] **Step 7: opencode connects to Roslynk**

```powershell
$env:OPENCODE_CONFIG_CONTENT = '{"mcp":{"playwright":{"type":"local","command":["npx"],"enabled":false},"aspire":{"type":"local","command":["aspire"],"enabled":false}}}'; opencode mcp list
```

Use a 3-minute timeout. Expected: `roslynk` connected; `playwright` and `aspire` disabled.

If `roslynk` fails with a spawn error naming `dnx`, record it and change nothing. On Windows `dnx` is `dnx.cmd`, which some runtimes cannot start without a shell. The template runs opencode in WSL (README: "on Windows, run everything in WSL"), where `dnx` is a plain executable. Report it as a Windows-only limitation of this check.

- [ ] **Step 8: Resolved permissions (only if `opencode debug agent` exists)**

```powershell
opencode debug agent developer; opencode debug agent debugger; opencode debug agent test-writer
```

Expected:
- developer and debugger show the global `roslynk_*` deny followed by the 20 `roslynk_*` allows, and none of the 8 write tools allowed. If the output lists available tools, it includes `roslynk_get_diagnostics` and excludes `roslynk_apply_patch`.
- test-writer shows only the deny.

- [ ] **Step 9: Skill discovery (only if `opencode debug skill` exists)**

```powershell
opencode debug skill
```

Expected: both `roslynk` and `vertical-slices` are listed.

- [ ] **Step 10: Stop the Roslynk daemons and remove the throwaway solution**

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'Morris\.Roslynk\.Mcp' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; "stopped $($_.ProcessId)" }; Remove-Item -Recurse -Force "C:\Users\Indiana.Kerrison\AppData\Local\Temp\rk smoke"
```

Expected: the daemons on 6502 and 6517 are stopped, and the folder is gone.

- [ ] **Step 11: Report to the human**

- Each check's result, with any failure output.
- Any non-JSON stdout lines from the first `dnx` run (Task 1 Step 8).
- The outcome of `opencode mcp list` on Windows, and whether the debug commands existed.
- That `opencode-ai` is still installed globally (`npm uninstall -g opencode-ai` removes it).
- That the commits are on `claude/roslynk-mcp-integration-030840` and have not been pushed.
- The open question: keep `docs/superpowers/` in the template, or drop it before merging. The README lists exactly which folders the template adds, and `docs/` is not one of them.

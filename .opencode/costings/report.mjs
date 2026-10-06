// Reads the token usage database for the /costings page (readUsage) and its two CSV exports. Every function
// accepts db = null, meaning nothing has been recorded yet.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { TOTAL_SQL } from './schema.mjs';

export const FILTERS = ['all', 'feature', 'bug', 'other'];
export const SUMMARY_HEADER = ['change', 'type', 'status', 'finished', 'agent', 'model', 'runs', 'input', 'output', 'reasoning', 'cache_read', 'cache_write', 'total', 'cost_usd'];
export const REPLIES_HEADER = ['completed', 'change', 'type', 'agent', 'model', 'session', 'parent_session', 'input', 'output', 'reasoning', 'cache_read', 'cache_write', 'total', 'cost_usd'];

// The workflow's order; other agents (opencode's own, say) follow by total.
const AGENT_ORDER = ['senior-dev', 'platform', 'debugger', 'test-writer', 'test-reviewer', 'developer'];
const AGENT_DIRS = ['.opencode/agents', '.opencode/agent'];
const SUMS = `COUNT(DISTINCT session_id) AS runs, COALESCE(SUM(input), 0) AS input, COALESCE(SUM(output), 0) AS output,
  COALESCE(SUM(reasoning), 0) AS reasoning, COALESCE(SUM(cache_read), 0) AS cache_read, COALESCE(SUM(cache_write), 0) AS cache_write,
  COALESCE(SUM(${TOTAL_SQL}), 0) AS total, COALESCE(SUM(cost), 0) AS cost, MIN(completed_at) AS first, MAX(completed_at) AS last`;
const NO_ROWS = { runs: 0, input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 };

const iso = (ms) => (ms == null || ms === 0 ? null : new Date(Number(ms)).toISOString());
const roundCost = (value) => Math.round(Number(value || 0) * 1e6) / 1e6;
const matches = (filter, type) => filter === 'all' || filter === type;
const rank = (agent) => {
  const i = AGENT_ORDER.indexOf(agent);
  return i === -1 ? AGENT_ORDER.length : i;
};
const byAgent = (a, b) => rank(a.agent) - rank(b.agent) || b.total - a.total || a.agent.localeCompare(b.agent);
const byLastActivity = (a, b) => String(b.lastActivity ?? '').localeCompare(String(a.lastActivity ?? ''));

function tokensOf(row) {
  return {
    runs: Number(row.runs),
    input: Number(row.input),
    output: Number(row.output),
    reasoning: Number(row.reasoning),
    cacheRead: Number(row.cache_read),
    cacheWrite: Number(row.cache_write),
    total: Number(row.total),
    cost: roundCost(row.cost),
  };
}

function agentUsage(row) {
  return { agent: row.agent, models: String(row.models ?? '').split(',').filter(Boolean).sort(), ...tokensOf(row) };
}

/** An open change's type (from its .openspec.yaml, else the fix- naming rule) and phase (from its status.md). */
export function changeFolderInfo(root, name) {
  const dir = path.join(root, 'openspec', 'changes', name);
  let type = name.startsWith('fix-') ? 'bug' : 'feature';
  let phase = null;
  try {
    const yaml = readFileSync(path.join(dir, '.openspec.yaml'), 'utf8');
    const schema = /^schema:[ \t]*["']?([\w-]+)/m.exec(yaml)?.[1];
    if (schema) type = schema === 'vsa-tdd-bugfix' ? 'bug' : 'feature';
  } catch {}
  try {
    phase = /^phase:[ \t]*(\S+)/m.exec(readFileSync(path.join(dir, 'status.md'), 'utf8'))?.[1] ?? null;
  } catch {}
  return { type, phase };
}

/** Each agent's colour from the `color:` line in its frontmatter (.opencode/agents/*.md). */
export function agentColors(root) {
  const colors = {};
  for (const dir of AGENT_DIRS) {
    let files;
    try {
      files = readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.md')).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      const name = file.slice(0, -3);
      if (Object.hasOwn(colors, name)) continue;
      try {
        const text = readFileSync(path.join(root, dir, file), 'utf8');
        const front = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
        const color = /^color:[ \t]*["']?(#[0-9A-Fa-f]{3,8})["']?[ \t\r]*$/m.exec(front)?.[1];
        if (color) colors[name] = color;
      } catch {}
    }
  }
  return colors;
}

/** Everything the page shows. */
export function readUsage(db, root) {
  const colors = agentColors(root);
  if (!db) return { recorded: false, changes: [], other: [], agentColors: colors };

  const finished = new Map(db.prepare('SELECT name, type, finished_at, summary FROM finished_change').all().map((r) => [r.name, r]));
  const totals = new Map(db.prepare(`SELECT change_name AS name, ${SUMS} FROM reply WHERE change_name IS NOT NULL GROUP BY change_name`).all().map((r) => [r.name, r]));
  const perAgent = db
    .prepare(`SELECT change_name AS name, agent, GROUP_CONCAT(DISTINCT model) AS models, ${SUMS} FROM reply WHERE change_name IS NOT NULL GROUP BY change_name, agent`)
    .all();

  const changes = [...new Set([...totals.keys(), ...finished.keys()])]
    .map((name) => {
      const done = finished.get(name);
      const t = totals.get(name);
      const folder = done ? null : changeFolderInfo(root, name);
      return {
        name,
        type: done ? done.type : folder.type,
        status: done ? 'finished' : 'open',
        finishedAt: iso(done?.finished_at),
        summary: done?.summary || null,
        phase: folder?.phase ?? null,
        firstActivity: iso(t?.first),
        lastActivity: iso(Math.max(Number(t?.last ?? 0), Number(done?.finished_at ?? 0))),
        totals: tokensOf(t ?? NO_ROWS),
        agents: perAgent.filter((r) => r.name === name).map(agentUsage).sort(byAgent),
      };
    })
    .sort(byLastActivity);

  const otherAgents = db
    .prepare(`SELECT command, agent, GROUP_CONCAT(DISTINCT model) AS models, ${SUMS} FROM reply WHERE change_name IS NULL GROUP BY command, agent`)
    .all();
  const other = db
    .prepare(`SELECT command, ${SUMS} FROM reply WHERE change_name IS NULL GROUP BY command`)
    .all()
    .map((row) => ({
      command: row.command ?? null,
      label: row.command ? `/${row.command}` : '(none)',
      type: 'other',
      lastActivity: iso(row.last),
      totals: tokensOf(row),
      agents: otherAgents.filter((r) => (r.command ?? null) === (row.command ?? null)).map(agentUsage).sort(byAgent),
    }))
    .sort(byLastActivity);

  return { recorded: true, changes, other, agentColors: colors };
}

export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; // keep spreadsheets from running a cell as a formula
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(header, rows) {
  // A byte-order mark so Excel reads UTF-8; CRLF line endings as in RFC 4180.
  return '\uFEFF' + [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const tokenCells = (r) => [
  Number(r.runs),
  Number(r.input),
  Number(r.output),
  Number(r.reasoning),
  Number(r.cache_read),
  Number(r.cache_write),
  Number(r.total),
  roundCost(r.cost),
];
const byAgentThenModel = (a, b) => rank(a.agent) - rank(b.agent) || a.agent.localeCompare(b.agent) || a.model.localeCompare(b.model);

/** One row per change, agent and model (changes newest first), then the Other rows. */
export function summaryCsv(db, root, filter = 'all') {
  const rows = [];
  if (db) {
    const usage = readUsage(db, root);
    const perModel = db
      .prepare(
        `SELECT change_name AS name, CASE WHEN change_name IS NULL THEN command END AS other_command, agent, model, ${SUMS}
         FROM reply GROUP BY change_name, other_command, agent, model`,
      )
      .all();
    if (filter !== 'other') {
      for (const change of usage.changes.filter((c) => matches(filter, c.type))) {
        for (const r of perModel.filter((p) => p.name === change.name).sort(byAgentThenModel)) {
          rows.push([change.name, change.type, change.status, change.finishedAt ?? '', r.agent, r.model, ...tokenCells(r)]);
        }
      }
    }
    if (matches(filter, 'other')) {
      for (const group of usage.other) {
        for (const r of perModel.filter((p) => p.name === null && (p.other_command ?? null) === group.command).sort(byAgentThenModel)) {
          rows.push([group.label, 'other', '', '', r.agent, r.model, ...tokenCells(r)]);
        }
      }
    }
  }
  return toCsv(SUMMARY_HEADER, rows);
}

/** One row per model reply, oldest first. */
export function repliesCsv(db, root, filter = 'all') {
  const rows = [];
  if (db) {
    const types = new Map(readUsage(db, root).changes.map((c) => [c.name, c.type]));
    const replies = db
      .prepare(
        `SELECT r.completed_at, r.change_name, r.command, r.agent, r.model, r.session_id, s.parent_id,
           r.input, r.output, r.reasoning, r.cache_read, r.cache_write, ${TOTAL_SQL} AS total, r.cost
         FROM reply r LEFT JOIN session s ON s.id = r.session_id ORDER BY r.completed_at, r.id`,
      )
      .all();
    for (const r of replies) {
      const type = r.change_name ? (types.get(r.change_name) ?? 'feature') : 'other';
      if (!matches(filter, type)) continue;
      rows.push([
        iso(r.completed_at),
        r.change_name ?? (r.command ? `/${r.command}` : '(none)'),
        type,
        r.agent,
        r.model,
        r.session_id,
        r.parent_id ?? '',
        Number(r.input),
        Number(r.output),
        Number(r.reasoning),
        Number(r.cache_read),
        Number(r.cache_write),
        Number(r.total),
        roundCost(r.cost),
      ]);
    }
  }
  return toCsv(REPLIES_HEADER, rows);
}

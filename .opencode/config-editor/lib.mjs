// Helpers for the opencode config editor: frontmatter parsing and rewriting, validation, `opencode models`
// output parsing and the agent-file I/O used by server.mjs. The browser-launch commands live in
// ../lib/local-web.mjs (shared with the token usage page) and are re-exported here. Node 20+ built-ins only
// (no package.json may live under .opencode/, because opencode bun-installs .opencode/package.json).

import { readFile, readdir, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export const APP_ID = 'opencode-config-editor';
export const VARIANTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const MODEL_RE = /^[A-Za-z0-9._-]+\/[^\s]+$/;
export const AGENT_DIRS = Object.freeze(['.opencode/agents', '.opencode/agent']);

// `opencode models` prints one `provider/model` per line.
const MODELS_LINE_RE = /^[A-Za-z0-9._-]+\/\S+$/;
// A top-level YAML key: starts in column 0, then `:` followed by whitespace or end of line.
const KEY_RE = /^([A-Za-z_][\w-]*)[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MAX_MODEL_LENGTH = 200;
const MAX_CHANGES = 100;

// ---------------------------------------------------------------------------
// Lines and frontmatter
// ---------------------------------------------------------------------------

/** Split text into lines that keep their own line ending, so `lines.join('')` round-trips byte for byte. */
export function splitLines(text) {
  if (text === '') return [];
  return text.split(/(?<=\n)/);
}

const lineBody = (line) => line.replace(/\r?\n$/, '');
const lineEnding = (line) => line.slice(lineBody(line).length);

/** Find the first frontmatter block. Returns { lines, close } (close = index of the closing `---`) or null. */
export function locateFrontmatter(text) {
  const lines = splitLines(text);
  if (!lines.length || lineBody(lines[0]).replace(/^﻿/, '').trimEnd() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if (lineBody(lines[i]).trimEnd() === '---') return { lines, close: i };
  }
  return null;
}

/** Parse a YAML scalar as written on a single line (quotes, trailing comments, booleans, null). */
export function parseScalar(raw) {
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim();
  if (value === '') return null;
  let m = /^"((?:[^"\\]|\\.)*)"(?:\s+#.*)?$/.exec(value);
  if (m) {
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return m[1];
    }
  }
  m = /^'((?:[^']|'')*)'(?:\s+#.*)?$/.exec(value);
  if (m) return m[1].replace(/''/g, "'");
  const plain = value.replace(/\s+#.*$/, '').trim();
  if (/^(true|True|TRUE)$/.test(plain)) return true;
  if (/^(false|False|FALSE)$/.test(plain)) return false;
  if (/^(null|Null|NULL|~)$/.test(plain)) return null;
  return plain;
}

/**
 * Read the top-level scalar keys of the first frontmatter block. Nested maps (such as
 * `permission:`) come back as null; simple folded/literal/continued scalars are joined.
 * This is deliberately tiny: it is not a YAML parser.
 */
export function parseFrontmatter(text) {
  const fm = locateFrontmatter(text);
  if (!fm) return null;
  const out = {};
  const { lines, close } = fm;
  for (let i = 1; i < close; i++) {
    const m = KEY_RE.exec(lineBody(lines[i]));
    if (!m || Object.prototype.hasOwnProperty.call(out, m[1])) continue;
    const raw = m[2] ?? '';
    // Indented lines that follow belong to this key (a nested map or a multi-line scalar).
    const more = [];
    while (i + 1 < close && /^([ \t]|\r?\n$)/.test(lines[i + 1])) more.push(lineBody(lines[++i]).trim());
    while (more.length && more[more.length - 1] === '') more.pop();
    if (/^[>|][+-]?\d*$/.test(raw.replace(/\s+#.*$/, ''))) {
      out[m[1]] = raw.startsWith('|') ? more.join('\n') : more.filter(Boolean).join(' ');
    } else if (raw === '') {
      out[m[1]] = null; // nested map or list
    } else {
      const first = parseScalar(raw);
      out[m[1]] = more.length && typeof first === 'string' ? [first, ...more].filter(Boolean).join(' ') : first;
    }
  }
  return out;
}

/** Format a model id as a YAML value: plain when that is unambiguous, otherwise double-quoted. */
export function formatModelValue(model) {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._/@+=:-]*[A-Za-z0-9._/@+=-]$/.test(model) ? model : JSON.stringify(model);
}

// Rebuild a `key: value` line, keeping double quotes and a trailing comment if the old line had them.
function renderKeyLine(key, value, oldBody) {
  const m = oldBody ? KEY_RE.exec(oldBody) : null;
  const oldRaw = m?.[2] ?? '';
  let rendered = key === 'model' ? formatModelValue(value) : value;
  if (oldRaw.startsWith('"')) rendered = JSON.stringify(value);
  const comment = /^"(?:[^"\\]|\\.)*"(\s+#.*)$|^'(?:[^']|'')*'(\s+#.*)$|^[^"'].*?(\s+#.*)$/.exec(oldRaw);
  const tail = comment ? comment[1] ?? comment[2] ?? comment[3] ?? '' : '';
  return `${key}: ${rendered}${tail}`;
}

/**
 * Change `model:` and/or `variant:` in the first frontmatter block and leave every other byte alone.
 * change.model: string to set (undefined/null = leave as is).
 * change.variant: string to set, '' to remove the line (undefined/null = leave as is).
 * New lines use the line ending of the line they are inserted after, so CRLF files stay CRLF.
 */
export function rewriteFrontmatter(text, change) {
  const fm = locateFrontmatter(text);
  if (!fm) throw new Error('no YAML frontmatter block at the top of the file');
  const lines = fm.lines;
  let close = fm.close;

  const find = (key) => {
    for (let i = 1; i < close; i++) {
      const m = KEY_RE.exec(lineBody(lines[i]));
      if (m && m[1] === key) return i;
    }
    return -1;
  };
  const valueAt = (i) => parseScalar(KEY_RE.exec(lineBody(lines[i]))[2]);
  // Index of the last line belonging to the key at i (skips indented continuation lines).
  const endOfKey = (i) => {
    while (i + 1 < close && /^[ \t]/.test(lines[i + 1])) i++;
    return i;
  };
  const insertAfter = (i, body) => {
    lines.splice(i + 1, 0, body + (lineEnding(lines[i]) || '\n'));
    close++;
    return i + 1;
  };
  const replaceAt = (i, key, value) => {
    if (valueAt(i) === value) return; // unchanged: keep the original bytes, quoting and all
    lines[i] = renderKeyLine(key, value, lineBody(lines[i])) + lineEnding(lines[i]);
  };

  if (change.model !== undefined && change.model !== null) {
    const i = find('model');
    if (i >= 0) replaceAt(i, 'model', change.model);
    else {
      const d = find('description');
      insertAfter(d >= 0 ? endOfKey(d) : 0, renderKeyLine('model', change.model));
    }
  }

  if (change.variant !== undefined && change.variant !== null) {
    const i = find('variant');
    if (change.variant === '') {
      if (i >= 0) {
        lines.splice(i, 1);
        close--;
      }
    } else if (i >= 0) replaceAt(i, 'variant', change.variant);
    else {
      const m = find('model');
      const d = find('description');
      insertAfter(m >= 0 ? m : d >= 0 ? endOfKey(d) : 0, renderKeyLine('variant', change.variant));
    }
  }

  return lines.join('');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function isValidModel(model) {
  return typeof model === 'string' && model.length <= MAX_MODEL_LENGTH && MODEL_RE.test(model) && !CONTROL_RE.test(model);
}

export function isValidVariant(variant) {
  return variant === '' || VARIANTS.includes(variant);
}

/**
 * Validate a POST /api/agents body against the list of existing agent names.
 * Returns { errors, changes }; when errors is non-empty nothing may be written.
 */
export function validateChanges(body, agentNames) {
  const errors = [];
  const changes = [];
  if (!body || typeof body !== 'object' || !Array.isArray(body.changes)) {
    return { errors: [{ message: 'Expected a JSON body like {"changes":[{"name","model","variant"}]}' }], changes };
  }
  if (body.changes.length === 0) return { errors: [{ message: 'No changes to save' }], changes };
  if (body.changes.length > MAX_CHANGES) return { errors: [{ message: `Too many changes (max ${MAX_CHANGES})` }], changes };

  const seen = new Set();
  body.changes.forEach((c, index) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      errors.push({ index, message: 'Each change must be an object' });
      return;
    }
    const { name, model, variant } = c;
    // The name is only ever matched against the existing list; it never becomes part of a path.
    if (typeof name !== 'string' || !agentNames.includes(name)) {
      errors.push({ index, field: 'name', message: `Unknown agent "${String(name).slice(0, 80)}"` });
      return;
    }
    if (seen.has(name)) {
      errors.push({ index, name, field: 'name', message: `Agent "${name}" appears more than once` });
      return;
    }
    seen.add(name);
    const hasModel = model !== undefined && model !== null;
    const hasVariant = variant !== undefined && variant !== null;
    if (!hasModel && !hasVariant) errors.push({ index, name, message: 'Nothing to change: give a model or a variant' });
    if (hasModel && !isValidModel(model)) {
      errors.push({ index, name, field: 'model', message: 'Model must look like provider/model, for example anthropic/claude-opus-5-5' });
    }
    if (hasVariant && !isValidVariant(variant)) {
      errors.push({ index, name, field: 'variant', message: `Effort must be one of: ${VARIANTS.join(', ')} (or empty to unset)` });
    }
    changes.push({ name, model: hasModel ? model : undefined, variant: hasVariant ? variant : undefined });
  });
  return { errors, changes: errors.length ? [] : changes };
}

// ---------------------------------------------------------------------------
// `opencode models` output
// ---------------------------------------------------------------------------

export function stripAnsi(text) {
  // CSI sequences, OSC sequences (terminated by BEL or ST) and lone two-byte escapes.
  return String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, '');
}

/** Group `provider/model` lines into { provider: [full ids…] }, ignoring colours, blanks and log noise. */
export function parseModelsOutput(text) {
  const providers = {};
  const seen = new Set();
  for (const raw of stripAnsi(text).split(/\r?\n|\r/)) {
    const line = raw.trim();
    if (!MODELS_LINE_RE.test(line) || seen.has(line)) continue;
    seen.add(line);
    const provider = line.slice(0, line.indexOf('/'));
    (providers[provider] ??= []).push(line);
  }
  return providers;
}

export function countModels(providers) {
  return Object.values(providers).reduce((n, list) => n + list.length, 0);
}

// ---------------------------------------------------------------------------
// Browser launch commands (shared with the token usage page)
// ---------------------------------------------------------------------------

export { isWsl, browserCommands } from '../lib/local-web.mjs';

// ---------------------------------------------------------------------------
// Agent files and opencode.json
// ---------------------------------------------------------------------------

/** Existing agent files: [{ name, file (relative, forward slashes), path (absolute) }], one entry per name. */
export async function listAgentFiles(root) {
  const out = [];
  const seen = new Set();
  for (const dir of AGENT_DIRS) {
    let entries;
    try {
      entries = await readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    const names = entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const fileName of names) {
      const name = fileName.slice(0, -3);
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, file: `${dir}/${fileName}`, path: path.join(root, dir, fileName) });
    }
  }
  return out;
}

/** Read a file as UTF-8, refusing files that would not survive a decode/encode round trip byte for byte. */
async function readUtf8Exact(file) {
  const buf = await readFile(file);
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) throw new Error('file is not valid UTF-8, refusing to rewrite it');
  return text;
}

const str = (v) => (v === null || v === undefined ? null : String(v));

export async function readAgents(root) {
  const files = await listAgentFiles(root);
  const agents = [];
  for (const f of files) {
    let fm = null;
    let error;
    try {
      fm = parseFrontmatter(await readFile(f.path, 'utf8'));
      if (!fm) error = 'no frontmatter block';
    } catch (err) {
      error = err.message;
    }
    fm ??= {};
    agents.push({
      name: f.name,
      file: f.file,
      description: str(fm.description) ?? '',
      mode: str(fm.mode) ?? 'all', // opencode's default for agents defined in files
      hidden: fm.hidden === true,
      color: str(fm.color),
      model: str(fm.model),
      variant: str(fm.variant),
      ...(error ? { error } : {}),
    });
  }
  return agents;
}

/** Display-only values from opencode.json. Any problem (missing file, comments, bad JSON) gives nulls. */
export async function readGlobalConfig(root) {
  const empty = { model: null, small_model: null, default_agent: null };
  try {
    const cfg = JSON.parse(await readFile(path.join(root, 'opencode.json'), 'utf8'));
    if (!cfg || typeof cfg !== 'object') return empty;
    return { model: str(cfg.model), small_model: str(cfg.small_model), default_agent: str(cfg.default_agent) };
  } catch {
    return empty;
  }
}

export class ValidationError extends Error {
  constructor(errors) {
    super(errors.map((e) => (e.name ? `${e.name}: ${e.message}` : e.message)).join('; '));
    this.errors = errors;
    this.status = 400;
  }
}

function tempPathFor(file) {
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
}

async function replaceFile(tmp, file, data) {
  try {
    await rename(tmp, file);
  } catch (err) {
    // Windows refuses to replace a file another program holds open; fall back to writing in place.
    if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
    await writeFile(file, data);
    await unlink(tmp).catch(() => {});
  }
}

/**
 * Validate and apply a POST /api/agents body. All or nothing: every new file body is computed
 * before anything is written, temp files are written before any rename, and a failed rename
 * rolls back the files already replaced. Returns the names of the files that actually changed.
 */
export async function applyChanges(root, body) {
  const files = await listAgentFiles(root);
  const byName = new Map(files.map((f) => [f.name, f]));
  const { errors, changes } = validateChanges(body, [...byName.keys()]);
  if (errors.length) throw new ValidationError(errors);

  const plan = [];
  for (const c of changes) {
    const f = byName.get(c.name);
    try {
      const before = await readUtf8Exact(f.path);
      const after = rewriteFrontmatter(before, c);
      if (after !== before) plan.push({ ...f, before, after, mode: (await stat(f.path)).mode & 0o777 });
    } catch (err) {
      errors.push({ name: c.name, message: `${f.file}: ${err.message}` });
    }
  }
  if (errors.length) throw new ValidationError(errors);

  const written = [];
  try {
    for (const p of plan) {
      p.tmp = tempPathFor(p.path);
      await writeFile(p.tmp, p.after, { flag: 'wx', mode: p.mode });
      written.push(p);
    }
  } catch (err) {
    await Promise.all(written.map((p) => unlink(p.tmp).catch(() => {})));
    throw err;
  }

  const replaced = [];
  try {
    for (const p of plan) {
      await replaceFile(p.tmp, p.path, p.after);
      replaced.push(p);
    }
  } catch (err) {
    for (const p of replaced) {
      const tmp = tempPathFor(p.path);
      await writeFile(tmp, p.before)
        .then(() => replaceFile(tmp, p.path, p.before))
        .catch(() => {});
    }
    await Promise.all(plan.filter((p) => !replaced.includes(p)).map((p) => unlink(p.tmp).catch(() => {})));
    throw err;
  }
  return plan.map((p) => p.name);
}

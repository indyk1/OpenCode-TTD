// Records the tokens of every model reply into the usage database, tagged with the change (feature or bug) the
// session is working on and the agent that replied. Driven by three opencode plugin hooks - `event`,
// `command.execute.before` and `tool.execute.after` - through .opencode/plugins/usage-recorder.js.
//
// Runtime-agnostic: `open()` returns a connection already prepared with prepareForWriting() (bun:sqlite inside
// opencode, node:sqlite in the tests). Nothing here ever throws into opencode: a failure becomes one warning per
// session, and that row is dropped.

const NAME = '[a-z0-9][a-z0-9-]*';
const NAME_RE = new RegExp(`^${NAME}$`);
const NEW_CHANGE_RE = new RegExp(`\\bopenspec\\s+new\\s+change\\s+["']?(${NAME})(?![a-z0-9-])`);
const CHANGE_PATH_RE = new RegExp(`openspec/changes/(${NAME})(?![a-z0-9-])`, 'g');
const CHANGE_FLAG_RE = new RegExp(`--change(?:\\s+|=)["']?(${NAME})(?![a-z0-9-])`);
// Tool arguments that hold a location. File contents (an edit's text, a written file) are never searched.
const LOCATION_ARGS = ['filePath', 'path', 'command', 'pattern', 'include'];

const isChangeName = (name) => typeof name === 'string' && NAME_RE.test(name) && name !== 'archive';

/** A token count as a whole number; anything missing, negative or not a number counts as 0. */
const count = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/** The change a shell command creates with `openspec new change "<name>"`, or null. */
export function changeCreatedBy(command) {
  const m = NEW_CHANGE_RE.exec(typeof command === 'string' ? command : '');
  return m && isChangeName(m[1]) ? m[1] : null;
}

/** The first active change a tool call's location arguments mention - a path under openspec/changes/, or --change <name>. */
export function changeMentionedIn(args) {
  if (!args || typeof args !== 'object') return null;
  const text = LOCATION_ARGS.map((key) => args[key])
    .filter((value) => typeof value === 'string')
    .join('\n')
    .replace(/\\/g, '/');
  for (const m of text.matchAll(CHANGE_PATH_RE)) if (isChangeName(m[1])) return m[1];
  const flag = CHANGE_FLAG_RE.exec(text);
  return flag && isChangeName(flag[1]) ? flag[1] : null;
}

export function createRecorder({ open, warn = () => {}, now = () => Date.now() }) {
  let db = null;
  const warned = new Set();

  function safely(sessionID, work) {
    try {
      db ??= open();
      work(db);
    } catch (err) {
      const key = typeof sessionID === 'string' ? sessionID : '';
      if (warned.has(key)) return;
      warned.add(key);
      try {
        warn(`token usage not recorded${key ? ` for session ${key}` : ''}: ${err?.message ?? err}`);
      } catch {}
    }
  }

  const sessionRow = (conn, id) => conn.prepare('SELECT change_name, command, command_at FROM session WHERE id = ?').get(id) ?? null;
  const ensureSession = (conn, id, at) =>
    conn.prepare('INSERT OR IGNORE INTO session (id, command_at, created_at) VALUES (?, ?, ?)').run(id, at, at);

  function recordSession(conn, info) {
    if (typeof info?.id !== 'string') throw new Error('session.created without a session id');
    const at = count(info.time?.created) || now();
    const parentID = typeof info.parentID === 'string' ? info.parentID : null;
    const parent = parentID ? sessionRow(conn, parentID) : null;
    // A subagent session works on the same change, under the same command, as the session that launched it.
    conn
      .prepare(
        `INSERT INTO session (id, parent_id, change_name, command, command_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET parent_id = COALESCE(session.parent_id, excluded.parent_id),
           change_name = COALESCE(session.change_name, excluded.change_name),
           command = COALESCE(session.command, excluded.command)`,
      )
      .run(info.id, parentID, parent?.change_name ?? null, parent?.command ?? null, at, at);
  }

  function recordReply(conn, info) {
    if (typeof info.id !== 'string' || typeof info.sessionID !== 'string' || !info.tokens || typeof info.tokens !== 'object') {
      throw new Error('a finished reply without an id, a session or token counts');
    }
    const completed = count(info.time.completed);
    ensureSession(conn, info.sessionID, count(info.time.created) || completed);
    const session = sessionRow(conn, info.sessionID);
    const tokens = info.tokens;
    const model = info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : String(info.modelID ?? 'unknown');
    const cost = Number(info.cost);
    // message.updated fires more than once per reply: the upsert keeps one row with the latest counts, and keeps
    // the change and command it was first stored (or back-filled) with.
    conn
      .prepare(
        `INSERT INTO reply (id, session_id, change_name, command, agent, model, completed_at,
           input, output, reasoning, cache_read, cache_write, cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET agent = excluded.agent, model = excluded.model, completed_at = excluded.completed_at,
           input = excluded.input, output = excluded.output, reasoning = excluded.reasoning,
           cache_read = excluded.cache_read, cache_write = excluded.cache_write, cost = excluded.cost`,
      )
      .run(
        info.id,
        info.sessionID,
        session?.change_name ?? null,
        session?.command ?? null,
        String(info.agent ?? info.mode ?? 'unknown'),
        model,
        completed,
        count(tokens.input),
        count(tokens.output),
        count(tokens.reasoning),
        count(tokens.cache?.read),
        count(tokens.cache?.write),
        Number.isFinite(cost) && cost > 0 ? cost : 0,
      );
  }

  function recordCommand(conn, { command, sessionID, arguments: args }) {
    const name = String(command ?? '').trim().replace(/^\//, '');
    if (!name) return;
    const at = now();
    ensureSession(conn, sessionID, at);
    // Every command starts a new piece of work; only /resume names its change straight away.
    const target = name === 'resume' ? String(args ?? '').trim().split(/\s+/)[0] : '';
    conn
      .prepare('UPDATE session SET command = ?, command_at = ?, change_name = ? WHERE id = ?')
      .run(name, at, isChangeName(target) ? target : null, sessionID);
  }

  function assignChange(conn, sessionID, name, explicit) {
    ensureSession(conn, sessionID, now());
    const session = sessionRow(conn, sessionID);
    if (session.change_name === name || (session.change_name && !explicit)) return;
    const tree = 'WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT s.id FROM session s JOIN tree t ON s.parent_id = t.id)';
    conn.exec('BEGIN IMMEDIATE');
    try {
      conn.prepare('UPDATE session SET change_name = ? WHERE id = ?').run(name, sessionID);
      if (session.change_name == null) {
        // The first name a piece of work gets also covers its replies since its command (the planning before
        // `openspec new change`), in this session and the subagent sessions it launched.
        conn
          .prepare(
            `${tree} UPDATE reply SET change_name = ? WHERE change_name IS NULL AND completed_at >= ? AND session_id IN (SELECT id FROM tree)`,
          )
          .run(sessionID, name, session.command_at);
        conn
          .prepare(`${tree} UPDATE session SET change_name = ? WHERE change_name IS NULL AND id IN (SELECT id FROM tree)`)
          .run(sessionID, name);
      }
      conn.exec('COMMIT');
    } catch (err) {
      try {
        conn.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  return {
    /** opencode `event` hook: session.created and finished assistant replies. */
    event(input) {
      const event = input?.event;
      const info = event?.properties?.info;
      if (event?.type === 'session.created') safely(info?.id, (conn) => recordSession(conn, info));
      else if (event?.type === 'message.updated' && info?.role === 'assistant' && info.time?.completed) {
        safely(info.sessionID, (conn) => recordReply(conn, info));
      }
    },
    /** opencode `command.execute.before` hook: runs before the command's prompt. */
    commandBefore(input) {
      if (typeof input?.sessionID === 'string') safely(input.sessionID, (conn) => recordCommand(conn, input));
    },
    /** opencode `tool.execute.after` hook: `openspec new change` names the change; a mention can name an unnamed session. */
    toolAfter(input) {
      if (typeof input?.sessionID !== 'string') return;
      const created = input.tool === 'bash' ? changeCreatedBy(input.args?.command) : null;
      const name = created ?? changeMentionedIn(input.args);
      if (name) safely(input.sessionID, (conn) => assignChange(conn, input.sessionID, name, created !== null));
    },
  };
}

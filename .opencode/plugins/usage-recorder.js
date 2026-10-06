// opencode plugin: records the tokens of every model reply into .workflow/usage.db, tagged with the change
// (feature or bug) and the agent, for the /costings page. The logic lives in ../costings/recorder.mjs; see
// .opencode/costings/README.md.
//
// The default export suits both plugin loaders: OpenCode 1.18.29+ calls server() for the hooks below, and OpenCode
// V2 (2.x) requires { id, setup }. V2 replaced those hooks with an event stream and tool hooks, which setup() turns
// back into the recorder's inputs through ../costings/opencode2.mjs.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpencode2Adapter, readCommands } from '../costings/opencode2.mjs';
import { createRecorder } from '../costings/recorder.mjs';
import { dbPath, prepareForWriting } from '../costings/schema.mjs';
import { loadSqlite } from '../costings/sqlite.mjs';

// The project root is two folders above this file, wherever opencode was started from.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// A recorder that writes the project's usage database. Both opencode versions run plugins on Bun, which has bun:sqlite;
// node:sqlite is the fallback (and what the tests use). Both are imported here rather than at the top so the module
// also loads outside Bun.
async function openRecorder(warn) {
  let Database;
  try {
    ({ Database } = await import('bun:sqlite'));
  } catch {
    Database = await loadSqlite();
  }
  const file = dbPath(ROOT);
  let db = null;
  const recorder = createRecorder({
    open: () => {
      mkdirSync(path.dirname(file), { recursive: true });
      db = prepareForWriting(new Database(file));
      return db;
    },
    warn,
  });
  return { recorder, close: () => db?.close() };
}

async function server({ client }) {
  const { recorder } = await openRecorder((message) => {
    Promise.resolve(client?.app?.log?.({ body: { service: 'usage-recorder', level: 'warn', message } })).catch(() => {});
  });
  return {
    event: async (input) => recorder.event(input),
    'command.execute.before': async (input) => recorder.commandBefore(input),
    'tool.execute.after': async (input) => recorder.toolAfter(input),
  };
}

// OpenCode 1.18.x also calls setup(), with a context that has only the transform domains (no event or tool), while
// server() does the recording: there setup() must do nothing, or every reply would be recorded twice. On V2 the
// context has the event stream and the tool hooks, and this is where recording happens. V2 has no client log, so
// problems go to the console, once each.
async function setup(ctx) {
  if (typeof ctx?.event?.subscribe !== 'function' || typeof ctx?.tool?.hook !== 'function') return;
  const warned = new Set();
  const warn = (message) => {
    if (warned.has(message)) return;
    warned.add(message);
    console.warn(`[usage-recorder] ${message}`);
  };
  let usage;
  try {
    usage = await openRecorder(warn);
  } catch (err) {
    warn(`token usage not recorded: ${err?.message ?? err}`);
    return;
  }
  const adapter = createOpencode2Adapter({ recorder: usage.recorder, commands: () => readCommands(ROOT) });
  try {
    await ctx.tool.hook('execute.after', (call) => adapter.onToolAfter(call));
  } catch (err) {
    warn(`token usage not recorded for shell commands and file reads: ${err?.message ?? err}`);
  }
  const stop = new AbortController();
  (async () => {
    try {
      for await (const event of await ctx.event.subscribe({ signal: stop.signal })) adapter.onEvent(event);
    } catch (err) {
      if (!stop.signal.aborted) warn(`token usage is no longer recorded: ${err?.message ?? err}`);
    }
  })();
  return () => {
    stop.abort();
    try {
      usage.close();
    } catch {}
  };
}

export default { id: 'usage-recorder', server, setup };

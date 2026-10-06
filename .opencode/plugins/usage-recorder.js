// opencode plugin: records the tokens of every model reply into .workflow/usage.db, tagged with the change
// (feature or bug) and the agent, for the /costings page. The logic lives in ../costings/recorder.mjs; see
// .opencode/costings/README.md.
//
// The default export suits both plugin loaders: OpenCode 1.18.29+ calls server() for the hooks below, and OpenCode
// V2 (2.x) requires { id, setup }. V2 replaced these hooks with different events, so setup() records nothing yet.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecorder } from '../costings/recorder.mjs';
import { dbPath, prepareForWriting } from '../costings/schema.mjs';

// The project root is two folders above this file, wherever opencode was started from.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

async function server({ client }) {
  // Imported here rather than at the top so the module also loads outside Bun (the tests run under Node).
  const { Database } = await import('bun:sqlite');
  const file = dbPath(ROOT);
  const recorder = createRecorder({
    open: () => {
      mkdirSync(path.dirname(file), { recursive: true });
      return prepareForWriting(new Database(file));
    },
    warn: (message) => {
      Promise.resolve(client?.app?.log?.({ body: { service: 'usage-recorder', level: 'warn', message } })).catch(() => {});
    },
  });
  return {
    event: async (input) => recorder.event(input),
    'command.execute.before': async (input) => recorder.commandBefore(input),
    'tool.execute.after': async (input) => recorder.toolAfter(input),
  };
}

// OpenCode 1.18.x also calls setup(), with a context that has only the transform domains (no event or tool), while
// server() does the recording. On V2 the plugin loads, but nothing is recorded yet.
async function setup() {}

export default { id: 'usage-recorder', server, setup };

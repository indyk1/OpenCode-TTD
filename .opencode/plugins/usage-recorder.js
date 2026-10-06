// opencode plugin: records the tokens of every model reply into .workflow/usage.db, tagged with the change
// (feature or bug) and the agent, for the /costings page. The logic lives in ../costings/recorder.mjs; see
// .opencode/costings/README.md.
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecorder } from '../costings/recorder.mjs';
import { dbPath, prepareForWriting } from '../costings/schema.mjs';

// The project root is two folders above this file, wherever opencode was started from.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export const UsageRecorder = async ({ client }) => {
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
};

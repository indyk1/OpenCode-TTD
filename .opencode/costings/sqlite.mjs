// Loads node:sqlite (Node 22.13+) without its "SQLite is an experimental feature" warning, so the one line
// /costings prints stays one line. Every other warning still prints.
let DatabaseSync = null;

export async function loadSqlite() {
  if (DatabaseSync) return DatabaseSync;
  const original = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    if (warning?.name === 'ExperimentalWarning' && /SQLite/i.test(String(warning.message))) return;
    for (const listener of original) listener(warning);
  });
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    throw new Error(`token usage needs Node.js 22.13 or newer (this is ${process.version})`);
  }
  return DatabaseSync;
}

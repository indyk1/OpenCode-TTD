import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT, makeProject, openDb } from './_helpers.mjs';

// The plugin file is what opencode loads from .opencode/plugins/. OpenCode V2 rejects a module unless its default
// export is { id, setup } ("Plugin must export a default definition with an id and an effect or setup function");
// OpenCode 1.18.29+ uses default.server() when the default export has one.
const load = () => import('../../plugins/usage-recorder.js');

test('the plugin default-exports a definition OpenCode V2 accepts', async () => {
  const { default: plugin } = await load();
  assert.equal(typeof plugin, 'object');
  assert.equal(plugin.id, 'usage-recorder');
  assert.equal(typeof plugin.setup, 'function');
});

test('the plugin gives OpenCode 1.x its hooks through default.server, and exports nothing else', async () => {
  const mod = await load();
  assert.deepEqual(Object.keys(mod), ['default']);
  assert.equal(typeof mod.default.server, 'function');
});

test('setup leaves a context without the V2 event and tool domains alone', async () => {
  const { default: plugin } = await load();
  // OpenCode 1.18.x also calls default.setup, with a context that has only the transform domains.
  const v1Shaped = { options: {}, agent: { transform() {} }, skill: { transform() {} }, command: { transform() {} } };
  assert.equal(await plugin.setup(v1Shaped), undefined);
  assert.equal(await plugin.setup(undefined), undefined);
  // Both domains are needed: a context with only one of them is left alone too, and nothing on it is called.
  const mustNotBeCalled = () => assert.fail('setup used a context it should have left alone');
  assert.equal(await plugin.setup({ event: { subscribe: mustNotBeCalled } }), undefined);
  assert.equal(await plugin.setup({ tool: { hook: mustNotBeCalled } }), undefined);
  assert.equal(await plugin.setup({ event: {}, tool: {} }), undefined);
});

// ---- opencode 2: setup() records through the event stream and the tool hook ----

// The plugin works out its project root from its own location, so each test runs a copy of the plugin and the
// recorder inside a throwaway project and never writes to this repository's .workflow/usage.db.
async function installedPlugin(t, { blockDatabase = false } = {}) {
  const project = makeProject();
  const opencode = path.join(project.root, '.opencode');
  cpSync(path.join(PROJECT_ROOT, '.opencode', 'plugins'), path.join(opencode, 'plugins'), { recursive: true });
  cpSync(path.join(PROJECT_ROOT, '.opencode', 'costings'), path.join(opencode, 'costings'), {
    recursive: true,
    filter: (source) => path.basename(source) !== 'test',
  });
  mkdirSync(path.join(opencode, 'commands'));
  writeFileSync(
    path.join(opencode, 'commands', 'resume.md'),
    '---\ndescription: Resume\n---\nUse the read tool to read openspec/changes/$ARGUMENTS/tasks.md, then reply with its first line only.\n',
  );
  if (blockDatabase) {
    // A file where the .workflow folder should be: the database cannot be created.
    rmSync(path.join(project.root, '.workflow'), { recursive: true });
    writeFileSync(path.join(project.root, '.workflow'), 'not a folder');
  }
  t.after(project.cleanup);
  const { default: plugin } = await import(pathToFileURL(path.join(opencode, 'plugins', 'usage-recorder.js')).href);
  return { plugin, root: project.root };
}

/** What opencode 2 gives setup(): an event stream to subscribe to, and tool hooks. `push` delivers an event to it. */
function fakeV2Context() {
  const queue = [];
  let wake = () => {};
  const ctx = {
    hooks: new Map(),
    subscriptions: [],
    streamEnded: false,
    push(event) {
      queue.push(event);
      wake();
    },
    tool: { hook: async (name, handler) => void ctx.hooks.set(name, handler) },
    event: {
      subscribe: async (options) => {
        ctx.subscriptions.push(options);
        const { signal } = options;
        return {
          [Symbol.asyncIterator]: () => ({
            async next() {
              while (!signal.aborted && queue.length === 0) {
                await new Promise((resolve) => {
                  wake = resolve;
                  signal.addEventListener('abort', resolve, { once: true });
                });
              }
              if (signal.aborted) {
                ctx.streamEnded = true;
                return { done: true, value: undefined };
              }
              return { done: false, value: queue.shift() };
            },
          }),
        };
      },
    },
  };
  return ctx;
}

async function until(check, what) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const v2 = (type, data, created = Date.UTC(2026, 9, 6, 9, 0)) => ({ id: `evt_${type}`, created, type, durable: true, data });

test('setup on opencode 2 subscribes to the event stream, hooks the tools, and records until its cleanup runs', async (t) => {
  const { plugin, root } = await installedPlugin(t);
  const ctx = fakeV2Context();
  const cleanup = await plugin.setup(ctx);
  assert.equal(typeof cleanup, 'function');
  assert.deepEqual([...ctx.hooks.keys()], ['execute.after']);
  assert.equal(ctx.subscriptions.length, 1);
  assert.ok(ctx.subscriptions[0].signal instanceof AbortSignal);

  const resumeText = 'Use the read tool to read openspec/changes/cancel-orders/tasks.md, then reply with its first line only.';
  const model = { id: 'claude-opus-5-5', providerID: 'anthropic', variant: 'default' };
  ctx.push(v2('session.created', { sessionID: 'ses_a', projectID: 'prj_1', location: { directory: root }, subpath: '', slug: 'quiet-fox', version: '2.0.24' }));
  ctx.push(v2('session.inbox.enqueued', { sessionID: 'ses_a', inboxID: 'msg_u', item: { type: 'user', payload: { text: resumeText }, delivery: 'steer' } }));
  ctx.push(v2('session.step.started', { sessionID: 'ses_a', assistantMessageID: 'msg_1', agent: 'senior-dev', model, started: 1 }));
  ctx.push(v2('session.step.ended', { sessionID: 'ses_a', assistantMessageID: 'msg_1', finish: 'stop', cost: 0.02, tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 100, write: 5 } } }));

  const db = await openDb(root);
  try {
    await until(() => db.prepare('SELECT 1 FROM reply').get(), 'the reply row');
    assert.deepEqual({ ...db.prepare('SELECT id, change_name, command FROM session').get() }, { id: 'ses_a', change_name: 'cancel-orders', command: 'resume' });
    assert.deepEqual(
      { ...db.prepare('SELECT id, session_id, change_name, command, agent, model, input, output, reasoning, cache_read, cache_write, cost FROM reply').get() },
      { id: 'msg_1', session_id: 'ses_a', change_name: 'cancel-orders', command: 'resume', agent: 'senior-dev', model: 'anthropic/claude-opus-5-5', input: 10, output: 2, reasoning: 1, cache_read: 100, cache_write: 5, cost: 0.02 },
    );

    // The shell tool is called "shell" on opencode 2; the recorder knows it as "bash".
    ctx.hooks.get('execute.after')({ tool: 'shell', sessionID: 'ses_b', input: { command: 'openspec new change "fix-it" --schema vsa-tdd-bugfix' }, status: 'completed' });
    assert.equal(db.prepare('SELECT change_name FROM session WHERE id = ?').get('ses_b').change_name, 'fix-it');

    cleanup();
    await until(() => ctx.streamEnded, 'the event loop to stop');
    ctx.push(v2('session.created', { sessionID: 'ses_late' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(db.prepare('SELECT id FROM session ORDER BY id').all().map((r) => r.id), ['ses_a', 'ses_b']);
  } finally {
    db.close();
  }
});

test('setup on opencode 2 warns once through console.warn when the usage database cannot be written, and does not throw', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const { plugin } = await installedPlugin(t, { blockDatabase: true });
  const ctx = fakeV2Context();
  const cleanup = await plugin.setup(ctx);
  ctx.push(v2('session.created', { sessionID: 'ses_a' }));
  ctx.push(v2('session.step.ended', { sessionID: 'ses_a', assistantMessageID: 'msg_1', finish: 'stop', cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }));
  await until(() => warn.mock.callCount() > 0, 'the warning');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /usage-recorder.*token usage not recorded for session ses_a/);
  cleanup();
});

test('setup on opencode 2 survives an event stream that fails, and a tool hook that cannot be registered', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const { plugin } = await installedPlugin(t);
  const ctx = {
    tool: { hook: async () => Promise.reject(new Error('no hooks today')) },
    event: { subscribe: async () => Promise.reject(new Error('stream down')) },
  };
  const cleanup = await plugin.setup(ctx);
  assert.equal(typeof cleanup, 'function');
  await until(() => warn.mock.callCount() >= 2, 'both warnings');
  const messages = warn.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(messages.some((m) => /no hooks today/.test(m)), messages.join('\n'));
  assert.ok(messages.some((m) => /stream down/.test(m)), messages.join('\n'));
  cleanup();
});

test('opencode 1: server() still returns the three hooks and warns through the client log', async (t) => {
  const { plugin } = await installedPlugin(t, { blockDatabase: true });
  const logged = [];
  const hooks = await plugin.server({ client: { app: { log: async (entry) => void logged.push(entry) } } });
  assert.deepEqual(Object.keys(hooks), ['event', 'command.execute.before', 'tool.execute.after']);
  await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_a', time: { created: 1 } } } } });
  await hooks['command.execute.before']({ command: 'feature', sessionID: 'ses_a', arguments: 'x' });
  await hooks['tool.execute.after']({ tool: 'bash', sessionID: 'ses_a', callID: 'c1', args: { command: 'ls' } });
  assert.equal(logged.length, 1);
  assert.equal(logged[0].body.service, 'usage-recorder');
  assert.equal(logged[0].body.level, 'warn');
  assert.match(logged[0].body.message, /token usage not recorded for session ses_a/);
});

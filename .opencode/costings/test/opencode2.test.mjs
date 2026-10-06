import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { commandMatcher, createOpencode2Adapter, readCommands } from '../opencode2.mjs';
import { createRecorder } from '../recorder.mjs';
import { PROJECT_ROOT, makeProject, openDb, plain } from './_helpers.mjs';

// Payloads below have the shapes observed on opencode 2.0.24.
const RESUME = 'Use the read tool to read openspec/changes/$ARGUMENTS/tasks.md, then reply with its first line only.';
const SHELL = '!`echo SHELL-OK`\n\nReply with only the line above that starts with SHELL-, then stop.';
const SHELL_TEXT = 'SHELL-OK\r\n\n\nReply with only the line above that starts with SHELL-, then stop.';
const FEATURE = 'Start a new change for the request below.\n\nRequest: $ARGUMENTS';
const COMMANDS = [
  { name: 'resume', template: RESUME },
  { name: 'shelltest', template: SHELL },
  { name: 'feature', template: FEATURE },
];

const resumeText = (name) => `Use the read tool to read openspec/changes/${name}/tasks.md, then reply with its first line only.`;
const featureText = (request) => `Start a new change for the request below.\n\nRequest: ${request}`;

test('commandMatcher recognises a command from its expanded template and returns the arguments', () => {
  const match = commandMatcher(COMMANDS);
  assert.deepEqual(match(resumeText('smoke-change')), { name: 'resume', arguments: 'smoke-change' });
  assert.deepEqual(match(featureText('let customers cancel orders')), { name: 'feature', arguments: 'let customers cancel orders' });
  // The arguments keep their own line breaks; only the ends are trimmed.
  assert.deepEqual(match(featureText('line one\nline two\n')), { name: 'feature', arguments: 'line one\nline two' });
});

test('commandMatcher fills every $ARGUMENTS with the same text', () => {
  const match = commandMatcher([{ name: 'resume', template: 'Resume "$ARGUMENTS": read openspec/changes/$ARGUMENTS/status.md, then continue.' }]);
  assert.deepEqual(match('Resume "cancel-orders": read openspec/changes/cancel-orders/status.md, then continue.'), {
    name: 'resume',
    arguments: 'cancel-orders',
  });
  assert.equal(match('Resume "cancel-orders": read openspec/changes/other-change/status.md, then continue.'), null);
  // A template may put whitespace between the first and the repeated $ARGUMENTS.
  const spaced = commandMatcher([{ name: 'echo', template: 'Echo $ARGUMENTS and $ARGUMENTS again' }]);
  assert.deepEqual(spaced('Echo x and x again'), { name: 'echo', arguments: 'x' });
  assert.equal(spaced('Echo x and y again'), null);
});

test('commandMatcher treats !`...` as the command output, whatever it was', () => {
  const match = commandMatcher(COMMANDS);
  assert.deepEqual(match(SHELL_TEXT), { name: 'shelltest', arguments: '' });
  assert.deepEqual(match('a different\noutput\r\n\nReply with only the line above that starts with SHELL-, then stop.'), {
    name: 'shelltest',
    arguments: '',
  });
});

test('commandMatcher ignores line endings and runs of whitespace', () => {
  const match = commandMatcher([
    { name: 'resume', template: RESUME },
    { name: 'feature', template: FEATURE.replace(/\n/g, '\r\n') },
  ]);
  assert.deepEqual(match(featureText('a\nb').replace(/\n/g, '\r\n')), { name: 'feature', arguments: 'a\nb' });
  assert.deepEqual(match('Start a new change for the request below.\nRequest:   x  '), { name: 'feature', arguments: 'x' });
  assert.deepEqual(match(`  ${resumeText('smoke-change')}\n`), { name: 'resume', arguments: 'smoke-change' });
});

test('commandMatcher returns empty arguments when none were given', () => {
  const match = commandMatcher(COMMANDS);
  assert.deepEqual(match(resumeText('')), { name: 'resume', arguments: '' });
  assert.deepEqual(match(featureText('')), { name: 'feature', arguments: '' });
});

test('commandMatcher does not match free text, other commands or a template with no text of its own', () => {
  const match = commandMatcher([...COMMANDS, { name: 'catchall', template: '$ARGUMENTS' }, { name: 'blank', template: '  \n' }, { name: 'shell-only', template: '!`ls`' }]);
  assert.equal(match('please resume the cancel-orders change'), null);
  assert.equal(match('Use the read tool to read README.md'), null);
  assert.equal(match(`${resumeText('x')} And then some more.`), null);
  assert.equal(match(''), null);
  assert.equal(match(undefined), null);
  assert.equal(match({ text: 'x' }), null);
  assert.equal(commandMatcher([])('anything'), null);
  assert.equal(commandMatcher(undefined)('anything'), null);
});

test('commandMatcher prefers the template with the most text of its own', () => {
  const match = commandMatcher([
    { name: 'short', template: 'Do $ARGUMENTS' },
    { name: 'long', template: 'Do the thing: $ARGUMENTS' },
  ]);
  assert.deepEqual(match('Do the thing: tomorrow'), { name: 'long', arguments: 'tomorrow' });
  assert.deepEqual(match('Do it tomorrow'), { name: 'short', arguments: 'it tomorrow' });
});

test('commandMatcher takes $1 to $9 as any text and escapes the rest of the template', () => {
  const match = commandMatcher([{ name: 'cost', template: 'Cost (USD) [today]? $1 and $2.' }]);
  assert.deepEqual(match('Cost (USD) [today]? 5 and 7.'), { name: 'cost', arguments: '' });
  assert.equal(match('Cost USD today 5 and 7.'), null);
  assert.equal(match('Cost (USD) [today]? 5 and 7!'), null);
});

test('commandMatcher recognises every command of this project from its expansion', () => {
  const commands = readCommands(PROJECT_ROOT);
  for (const name of ['bug', 'config', 'costings', 'deploy', 'feature', 'resume', 'setup']) assert.ok(commands.some((c) => c.name === name), name);
  const match = commandMatcher(commands);
  const expand = (template, args, output) =>
    template.replace(/\r\n/g, '\n').replaceAll('$ARGUMENTS', args).replace(/!`[^`]*`/g, output);
  for (const { name, template } of commands) {
    const args = template.includes('$ARGUMENTS') ? 'let customers cancel orders' : '';
    assert.deepEqual(match(expand(template, args, 'Token usage page running at http://127.0.0.1:4330\r\n')), { name, arguments: args }, name);
  }
  assert.deepEqual(match(expand(commands.find((c) => c.name === 'resume').template, 'cancel-orders', '')), {
    name: 'resume',
    arguments: 'cancel-orders',
  });
});

test('readCommands reads .opencode/commands/*.md without the frontmatter, and skips what it cannot read', () => {
  const project = makeProject();
  try {
    const dir = path.join(project.root, '.opencode', 'commands');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'one.md'), '---\ndescription: One\nagent: senior-dev\n---\nDo one: $ARGUMENTS\n');
    writeFileSync(path.join(dir, 'two.md'), '---\r\ndescription: Two\r\n---\r\nDo two.\r\nSecond line.\r\n');
    writeFileSync(path.join(dir, 'three.md'), 'No frontmatter here.\n');
    writeFileSync(path.join(dir, 'notes.txt'), 'not a command');
    mkdirSync(path.join(dir, 'folder.md'));
    const commands = readCommands(project.root);
    assert.deepEqual(
      commands.map((c) => ({ name: c.name, template: c.template.replace(/\r\n/g, '\n') })).sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: 'one', template: 'Do one: $ARGUMENTS\n' },
        { name: 'three', template: 'No frontmatter here.\n' },
        { name: 'two', template: 'Do two.\nSecond line.\n' },
      ],
    );
    assert.deepEqual(readCommands(path.join(project.root, 'nowhere')), []);
  } finally {
    project.cleanup();
  }
});

// ---- the adapter, against a real database ----

const TOKENS = { input: 100, output: 20, reasoning: 5, cache: { read: 1000, write: 50 } };
const OPUS = { id: 'claude-opus-5-5', providerID: 'anthropic', variant: 'default' };
const SONNET = { id: 'claude-sonnet-5-5', providerID: 'anthropic', variant: 'default' };

async function setup(t) {
  const project = makeProject();
  const db = await openDb(project.root);
  const warnings = [];
  let clock = Date.UTC(2026, 9, 6, 9, 0);
  let seq = 0;
  const recorder = createRecorder({ open: () => db, warn: (m) => warnings.push(m), now: () => clock });
  const adapter = createOpencode2Adapter({ recorder, commands: () => COMMANDS });
  t.after(() => {
    db.close();
    project.cleanup();
  });
  const tick = (ms = 1000) => (clock += ms);
  const envelope = (type, data, created = tick()) => ({ id: `evt_${++seq}`, created, type, durable: true, data });
  return {
    adapter,
    db,
    warnings,
    tick,
    envelope,
    sessionCreated: (sessionID, { parentID, created } = {}) =>
      adapter.onEvent(
        envelope('session.created', { sessionID, projectID: 'prj_1', location: { directory: '/work' }, subpath: '', slug: 'quiet-fox', parentID, version: '2.0.24' }, created),
      ),
    userSaid: (sessionID, text, type = 'user') =>
      adapter.onEvent(envelope('session.inbox.enqueued', { sessionID, inboxID: `msg_${++seq}`, item: { type, payload: { text }, delivery: 'steer' } })),
    // A model step: started, then ended, with its tokens.
    step: (sessionID, id, { agent = 'senior-dev', model = OPUS, tokens = TOKENS, cost = 0.01 } = {}) => {
      adapter.onEvent(envelope('session.step.started', { sessionID, assistantMessageID: id, agent, model, started: tick(100) }));
      adapter.onEvent(envelope('session.step.ended', { sessionID, assistantMessageID: id, finish: 'stop', rawFinish: 'stop', cost, tokens }));
    },
    sessions: () => plain(db.prepare('SELECT id, parent_id, change_name, command, created_at FROM session ORDER BY created_at, id').all()),
    replies: () => plain(db.prepare('SELECT id, session_id, change_name, command, agent, model, completed_at FROM reply ORDER BY completed_at, id').all()),
  };
}

test('session.created becomes a session row, and a subagent inherits the change and command of its parent', async (t) => {
  const s = await setup(t);
  const created = Date.UTC(2026, 9, 6, 8, 0);
  s.sessionCreated('ses_a', { created });
  s.userSaid('ses_a', resumeText('cancel-orders'));
  s.sessionCreated('ses_b', { parentID: 'ses_a', created: created + 5000 });
  assert.deepEqual(s.sessions(), [
    { id: 'ses_a', parent_id: null, change_name: 'cancel-orders', command: 'resume', created_at: created },
    { id: 'ses_b', parent_id: 'ses_a', change_name: 'cancel-orders', command: 'resume', created_at: created + 5000 },
  ]);
  assert.deepEqual(s.warnings, []);
});

test('a finished step becomes a reply row with its agent, model, tokens and cost', async (t) => {
  const s = await setup(t);
  s.sessionCreated('ses_a');
  s.step('ses_a', 'msg_1', { agent: 'senior-dev', model: OPUS, cost: 0.25 });
  s.step('ses_a', 'msg_2', { agent: 'developer', model: SONNET, tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } });
  const rows = plain(
    s.db.prepare('SELECT id, session_id, agent, model, input, output, reasoning, cache_read, cache_write, cost FROM reply ORDER BY id').all(),
  );
  assert.deepEqual(rows, [
    { id: 'msg_1', session_id: 'ses_a', agent: 'senior-dev', model: 'anthropic/claude-opus-5-5', input: 100, output: 20, reasoning: 5, cache_read: 1000, cache_write: 50, cost: 0.25 },
    { id: 'msg_2', session_id: 'ses_a', agent: 'developer', model: 'anthropic/claude-sonnet-5-5', input: 7, output: 3, reasoning: 0, cache_read: 0, cache_write: 0, cost: 0.01 },
  ]);
  assert.deepEqual(s.warnings, []);
});

test('a step is completed at the time of its ended event, and an ended step the adapter never saw start is agent "unknown"', async (t) => {
  const s = await setup(t);
  s.sessionCreated('ses_a');
  const ended = Date.UTC(2026, 9, 6, 10, 30);
  s.adapter.onEvent(s.envelope('session.step.ended', { sessionID: 'ses_a', assistantMessageID: 'msg_1', finish: 'stop', cost: 0, tokens: TOKENS }, ended));
  assert.deepEqual(s.replies(), [
    { id: 'msg_1', session_id: 'ses_a', change_name: null, command: null, agent: 'unknown', model: 'unknown', completed_at: ended },
  ]);
  // A step is forgotten once it has ended: the same id coming round again is not the step that was remembered.
  s.step('ses_a', 'msg_2', { agent: 'developer' });
  s.adapter.onEvent(s.envelope('session.step.ended', { sessionID: 'ses_a', assistantMessageID: 'msg_2', finish: 'stop', cost: 0, tokens: TOKENS }));
  assert.equal(s.replies().find((r) => r.id === 'msg_2').agent, 'unknown');
});

test('/resume names the change at once, and the replies after it belong to that change', async (t) => {
  const s = await setup(t);
  s.sessionCreated('ses_a');
  s.userSaid('ses_a', resumeText('smoke-change'));
  s.step('ses_a', 'msg_1');
  assert.deepEqual(s.sessions().map((r) => [r.change_name, r.command]), [['smoke-change', 'resume']]);
  assert.deepEqual(s.replies().map((r) => [r.id, r.change_name, r.command]), [['msg_1', 'smoke-change', 'resume']]);
});

test('/feature starts work outside a change until the shell tool runs `openspec new change`, which names it and back-fills', async (t) => {
  const s = await setup(t);
  s.sessionCreated('ses_a');
  s.userSaid('ses_a', featureText('let customers cancel orders'));
  s.step('ses_a', 'msg_1');
  assert.deepEqual(s.replies().map((r) => [r.id, r.change_name, r.command]), [['msg_1', null, 'feature']]);
  s.adapter.onToolAfter({
    tool: 'shell',
    sessionID: 'ses_a',
    agent: 'senior-dev',
    messageID: 'msg_1',
    id: 'tc_1',
    input: { command: 'openspec new change "cancel-orders" --schema vsa-tdd' },
    status: 'completed',
    result: { output: { exit: 0, output: 'Created change cancel-orders\r\n', status: 'completed' } },
  });
  s.step('ses_a', 'msg_2');
  assert.deepEqual(s.replies().map((r) => [r.id, r.change_name, r.command]), [
    ['msg_1', 'cancel-orders', 'feature'],
    ['msg_2', 'cancel-orders', 'feature'],
  ]);
  assert.deepEqual(s.sessions().map((r) => r.change_name), ['cancel-orders']);
  assert.deepEqual(s.warnings, []);
});

test('other tools name an unnamed session by the change they read, and a failed tool call names nothing', async (t) => {
  const s = await setup(t);
  s.sessionCreated('ses_a');
  s.userSaid('ses_a', featureText('something'));
  s.adapter.onToolAfter({ tool: 'shell', sessionID: 'ses_a', input: { command: 'openspec new change "never-made"' }, status: 'error', error: { message: 'failed' } });
  assert.deepEqual(s.sessions().map((r) => r.change_name), [null]);
  // Only the shell tool is a shell: another tool's `command` argument is not an `openspec new change`.
  s.adapter.onToolAfter({ tool: 'write', sessionID: 'ses_a', input: { command: 'openspec new change "other-one"' }, status: 'completed' });
  assert.deepEqual(s.sessions().map((r) => r.change_name), [null]);
  s.adapter.onToolAfter({ tool: 'read', sessionID: 'ses_a', input: { filePath: 'openspec/changes/cancel-orders/proposal.md' }, status: 'completed' });
  assert.deepEqual(s.sessions().map((r) => r.change_name), ['cancel-orders']);
});

test('free text and non-user messages do not start a command', async (t) => {
  const s = await setup(t);
  s.sessionCreated('ses_a');
  s.userSaid('ses_a', resumeText('cancel-orders'));
  s.userSaid('ses_a', 'please carry on with the other thing');
  s.userSaid('ses_a', featureText('from a synthetic item'), 'synthetic');
  s.userSaid('ses_a', featureText('from a compaction item'), 'compaction');
  assert.deepEqual(s.sessions().map((r) => [r.change_name, r.command]), [['cancel-orders', 'resume']]);
});

test('a new command starts new work in the same session', async (t) => {
  const s = await setup(t);
  s.sessionCreated('ses_a');
  s.userSaid('ses_a', resumeText('cancel-orders'));
  s.step('ses_a', 'msg_1');
  s.userSaid('ses_a', SHELL_TEXT);
  s.step('ses_a', 'msg_2');
  assert.deepEqual(s.replies().map((r) => [r.id, r.change_name, r.command]), [
    ['msg_1', 'cancel-orders', 'resume'],
    ['msg_2', null, 'shelltest'],
  ]);
});

test('a compaction becomes a reply by the agent "compaction"; a generated title is not recorded', async (t) => {
  const s = await setup(t);
  s.sessionCreated('ses_a');
  s.userSaid('ses_a', resumeText('cancel-orders'));
  const compacted = Date.UTC(2026, 9, 6, 11, 0);
  const compaction = s.envelope('session.usage.recorded', { sessionID: 'ses_a', source: 'compaction', cost: 0.5, tokens: TOKENS }, compacted);
  s.adapter.onEvent(compaction);
  s.adapter.onEvent(s.envelope('session.usage.recorded', { sessionID: 'ses_a', source: 'title', cost: 0.001, tokens: TOKENS }));
  s.adapter.onEvent(s.envelope('session.usage.updated', { sessionID: 'ses_a', cost: 9, tokens: TOKENS }));
  assert.deepEqual(s.replies(), [
    { id: compaction.id, session_id: 'ses_a', change_name: 'cancel-orders', command: 'resume', agent: 'compaction', model: 'unknown', completed_at: compacted },
  ]);
  const row = s.db.prepare('SELECT input, output, reasoning, cache_read, cache_write, cost FROM reply').get();
  assert.deepEqual({ ...row }, { input: 100, output: 20, reasoning: 5, cache_read: 1000, cache_write: 50, cost: 0.5 });
  assert.deepEqual(s.warnings, []);
});

test('malformed or unrelated events are dropped without throwing, writing or warning', async (t) => {
  const s = await setup(t);
  const { envelope, adapter } = s;
  const events = [
    undefined,
    null,
    'session.created',
    42,
    {},
    { type: 'session.created' },
    envelope('session.created', null),
    envelope('session.created', { projectID: 'prj_1' }),
    envelope('session.created', { sessionID: 7 }),
    envelope('session.inbox.enqueued', { sessionID: 'ses_a' }),
    envelope('session.inbox.enqueued', { sessionID: 'ses_a', item: { type: 'user' } }),
    envelope('session.inbox.enqueued', { sessionID: 'ses_a', item: { type: 'user', payload: { text: 12 } } }),
    envelope('session.inbox.enqueued', { item: { type: 'user', payload: { text: resumeText('cancel-orders') } } }),
    envelope('session.step.started', null),
    envelope('session.step.started', { sessionID: 'ses_a' }),
    envelope('session.step.ended', null),
    envelope('session.step.ended', { sessionID: 'ses_a', assistantMessageID: 'msg_1' }),
    envelope('session.step.ended', { sessionID: 'ses_a', assistantMessageID: 'msg_1', tokens: 'many' }),
    envelope('session.step.ended', { assistantMessageID: 'msg_1', tokens: TOKENS }),
    envelope('session.step.ended', { sessionID: 'ses_a', tokens: TOKENS }),
    envelope('session.usage.recorded', null),
    envelope('session.usage.recorded', { sessionID: 'ses_a', source: 'compaction' }),
    { type: 'session.usage.recorded', data: { sessionID: 'ses_a', source: 'compaction', tokens: TOKENS } },
    envelope('session.step.streamed', { sessionID: 'ses_a', assistantMessageID: 'msg_1' }),
    envelope('something.else', { sessionID: 'ses_a' }),
  ];
  for (const event of events) assert.doesNotThrow(() => adapter.onEvent(event));
  for (const e of [undefined, null, 'shell', {}, { tool: 'shell' }, { tool: 'shell', sessionID: 7, input: { command: 'openspec new change "x"' } }, { tool: 'shell', sessionID: 'ses_a', input: 'echo hi' }]) {
    assert.doesNotThrow(() => adapter.onToolAfter(e));
  }
  assert.deepEqual(s.sessions(), []);
  assert.deepEqual(s.replies(), []);
  assert.deepEqual(s.warnings, []);
});

test('the adapter survives a recorder or a command list that throws', () => {
  const adapter = createOpencode2Adapter({
    recorder: {
      event() {
        throw new Error('boom');
      },
      commandBefore() {
        throw new Error('boom');
      },
      toolAfter() {
        throw new Error('boom');
      },
    },
    commands: () => {
      throw new Error('no commands');
    },
  });
  const envelope = (type, data) => ({ id: 'evt_1', created: 1, type, data });
  assert.doesNotThrow(() => adapter.onEvent(envelope('session.created', { sessionID: 'ses_a' })));
  assert.doesNotThrow(() => adapter.onEvent(envelope('session.inbox.enqueued', { sessionID: 'ses_a', item: { type: 'user', payload: { text: 'hi' } } })));
  assert.doesNotThrow(() => adapter.onEvent(envelope('session.step.ended', { sessionID: 'ses_a', assistantMessageID: 'msg_1', tokens: TOKENS })));
  assert.doesNotThrow(() => adapter.onToolAfter({ tool: 'shell', sessionID: 'ses_a', input: { command: 'ls' } }));
});

test('the adapter reads the command list again for each message, so an edited command is still recognised', async (t) => {
  const s = await setup(t);
  let list = [{ name: 'old', template: 'Old text: $ARGUMENTS' }];
  const adapter = createOpencode2Adapter({
    recorder: createRecorder({ open: () => s.db, now: () => 1 }),
    commands: () => list,
  });
  const said = (text) =>
    adapter.onEvent({ id: 'evt_1', created: 1, type: 'session.inbox.enqueued', data: { sessionID: 'ses_a', inboxID: 'msg_1', item: { type: 'user', payload: { text } } } });
  said('Old text: x');
  assert.equal(s.db.prepare('SELECT command FROM session WHERE id = ?').get('ses_a').command, 'old');
  list = [{ name: 'new', template: 'New text: $ARGUMENTS' }];
  said('New text: y');
  assert.equal(s.db.prepare('SELECT command FROM session WHERE id = ?').get('ses_a').command, 'new');
});

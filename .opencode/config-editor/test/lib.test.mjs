// Unit tests for lib.mjs: frontmatter rewriting, validation, models-output parsing, browser commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, readFileSync as read } from 'node:fs';
import path from 'node:path';
import {
  applyChanges,
  browserCommands,
  parseFrontmatter,
  parseModelsOutput,
  readAgents,
  readGlobalConfig,
  rewriteFrontmatter,
  stripAnsi,
  validateChanges,
  ValidationError,
} from '../lib.mjs';
import { AGENTS_DIR, differingLines, makeProject } from './_helpers.mjs';

const agentFiles = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md')).sort();
const original = Object.fromEntries(agentFiles.map((f) => [f, readFileSync(path.join(AGENTS_DIR, f), 'utf8')]));
const toCrlf = (s) => s.replace(/\r?\n/g, '\r\n');
const lineIndex = (text, prefix) => text.split(/(?<=\n)/).findIndex((l) => l.startsWith(prefix));

test('the template agent files are LF with model and variant lines (fixture sanity)', () => {
  assert.equal(agentFiles.length, 6);
  for (const [file, text] of Object.entries(original)) {
    assert.ok(!text.includes('\r'), `${file} should be LF`);
    assert.ok(lineIndex(text, 'model: ') > 0, `${file} has model:`);
    assert.ok(lineIndex(text, 'variant: ') > 0, `${file} has variant:`);
  }
});

test('parseFrontmatter reads the top-level scalars of every real agent file', () => {
  const fm = parseFrontmatter(original['debugger.md']);
  assert.equal(fm.model, 'anthropic/claude-opus-5-5');
  assert.equal(fm.variant, 'high');
  assert.equal(fm.mode, 'subagent');
  assert.equal(fm.hidden, true);
  assert.equal(fm.color, '#DC2626');
  assert.equal(fm.permission, null);
  assert.match(fm.description, /^Debugger\. Reproduces a reported bug/);
  assert.equal(parseFrontmatter(original['platform.md']).mode, 'all');
  assert.equal(parseFrontmatter(original['senior-dev.md']).hidden, undefined);
  // Nested permission keys never leak out as top-level keys.
  assert.equal(parseFrontmatter(original['senior-dev.md']).task, undefined);
  assert.equal(parseFrontmatter('no frontmatter here\n'), null);
});

test('parseFrontmatter handles quotes, comments, block scalars and a BOM', () => {
  const text = '﻿---\ndescription: >\n  Folded\n  text.\nmodel: "anthropic/x" # pinned\nvariant: \'low\'\nhidden: false\n---\nbody\n';
  assert.deepEqual(parseFrontmatter(text), { description: 'Folded text.', model: 'anthropic/x', variant: 'low', hidden: false });
});

for (const crlf of [false, true]) {
  test(`rewrite changes only the model and variant lines of every real agent file (${crlf ? 'CRLF' : 'LF'})`, () => {
    for (const [file, lf] of Object.entries(original)) {
      const before = crlf ? toCrlf(lf) : lf;
      const after = rewriteFrontmatter(before, { model: 'openai/gpt-5.1', variant: 'xhigh' });
      const changed = differingLines(before, after);
      assert.deepEqual(changed, [lineIndex(before, 'model: '), lineIndex(before, 'variant: ')], file);
      const lines = after.split(/(?<=\n)/);
      const eol = crlf ? '\r\n' : '\n';
      assert.equal(lines[changed[0]], `model: openai/gpt-5.1${eol}`);
      assert.equal(lines[changed[1]], `variant: xhigh${eol}`);
      if (crlf) assert.ok(!/[^\r]\n/.test(after), `${file}: no bare LF may appear in a CRLF file`);
      // Byte-level check: removing the two changed lines from both leaves identical buffers.
      const strip = (t) => Buffer.from(t.split(/(?<=\n)/).filter((_, i) => !changed.includes(i)).join(''));
      assert.ok(strip(before).equals(strip(after)), `${file}: bytes outside the changed lines differ`);
    }
  });
}

test('rewrite with the same values returns the input unchanged', () => {
  for (const text of Object.values(original)) {
    const fm = parseFrontmatter(text);
    assert.equal(rewriteFrontmatter(text, { model: fm.model, variant: fm.variant }), text);
  }
});

test('rewrite can change just the model or just the variant', () => {
  const text = original['developer.md'];
  assert.deepEqual(differingLines(text, rewriteFrontmatter(text, { model: 'anthropic/claude-opus-5-5' })), [lineIndex(text, 'model: ')]);
  assert.deepEqual(differingLines(text, rewriteFrontmatter(text, { variant: 'max' })), [lineIndex(text, 'variant: ')]);
});

for (const eol of ['\n', '\r\n']) {
  const name = eol === '\n' ? 'LF' : 'CRLF';

  test(`variant '' removes the variant line and nothing else (${name})`, () => {
    const text = eol === '\n' ? original['test-writer.md'] : toCrlf(original['test-writer.md']);
    const expected = text.replace(`variant: high${eol}`, '');
    assert.notEqual(expected, text);
    assert.equal(rewriteFrontmatter(text, { variant: '' }), expected);
  });

  test(`a missing variant line is inserted right after model: (${name})`, () => {
    const base = eol === '\n' ? original['test-writer.md'] : toCrlf(original['test-writer.md']);
    const without = base.replace(`variant: high${eol}`, '');
    const after = rewriteFrontmatter(without, { model: 'anthropic/claude-sonnet-5-5', variant: 'max' });
    assert.equal(after, base.replace('variant: high', 'variant: max'));
  });

  test(`a missing model line goes after description:, or first when there is none (${name})`, () => {
    const withDesc = ['---', 'description: Helper.', 'mode: subagent', '---', 'Body', ''].join(eol);
    assert.equal(
      rewriteFrontmatter(withDesc, { model: 'anthropic/claude-haiku-4-5', variant: 'low' }),
      ['---', 'description: Helper.', 'model: anthropic/claude-haiku-4-5', 'variant: low', 'mode: subagent', '---', 'Body', ''].join(eol),
    );
    const noDesc = ['---', 'mode: subagent', '---', 'Body', ''].join(eol);
    assert.equal(
      rewriteFrontmatter(noDesc, { model: 'openai/gpt-5.1' }),
      ['---', 'model: openai/gpt-5.1', 'mode: subagent', '---', 'Body', ''].join(eol),
    );
    const multiLineDesc = ['---', 'description: >', '  Two', '  lines.', 'mode: all', '---', ''].join(eol);
    assert.equal(
      rewriteFrontmatter(multiLineDesc, { model: 'openai/gpt-5.1' }),
      ['---', 'description: >', '  Two', '  lines.', 'model: openai/gpt-5.1', 'mode: all', '---', ''].join(eol),
    );
  });
}

test('rewrite keeps a missing trailing newline missing, and only touches the first frontmatter block', () => {
  const text = '---\nmodel: a/b\nvariant: low\n---\nBody\n---\nmodel: c/d\n---\nend';
  assert.equal(rewriteFrontmatter(text, { model: 'x/y', variant: 'high' }), '---\nmodel: x/y\nvariant: high\n---\nBody\n---\nmodel: c/d\n---\nend');
});

test('rewrite ignores nested keys that look like model:', () => {
  const text = '---\ndescription: d\noptions:\n  model: nested/one\n---\n';
  assert.equal(rewriteFrontmatter(text, { model: 'top/level' }), '---\ndescription: d\nmodel: top/level\noptions:\n  model: nested/one\n---\n');
});

test('rewrite keeps double quotes and trailing comments on the lines it changes', () => {
  const text = '---\nmodel: "anthropic/a" # main\nvariant: low   # cheap\n---\n';
  assert.equal(rewriteFrontmatter(text, { model: 'anthropic/b', variant: 'max' }), '---\nmodel: "anthropic/b" # main\nvariant: max   # cheap\n---\n');
});

test('rewrite quotes model ids that would not be plain YAML scalars', () => {
  const text = '---\nmodel: a/b\n---\n';
  assert.equal(rewriteFrontmatter(text, { model: 'bedrock/anthropic.claude-3:0' }), '---\nmodel: bedrock/anthropic.claude-3:0\n---\n');
  assert.equal(rewriteFrontmatter(text, { model: 'x/ends-with:' }), '---\nmodel: "x/ends-with:"\n---\n');
  assert.equal(rewriteFrontmatter(text, { model: 'x/has#hash' }), '---\nmodel: "x/has#hash"\n---\n');
});

test('rewrite refuses a file without frontmatter', () => {
  assert.throws(() => rewriteFrontmatter('# Just markdown\n', { model: 'a/b' }), /no YAML frontmatter/);
  assert.throws(() => rewriteFrontmatter('---\nmodel: a/b\n', { model: 'a/c' }), /no YAML frontmatter/);
});

test('validateChanges accepts well-formed changes', () => {
  const names = ['senior-dev', 'developer'];
  const { errors, changes } = validateChanges(
    { changes: [{ name: 'senior-dev', model: 'anthropic/claude-opus-5-5', variant: 'max' }, { name: 'developer', variant: '' }] },
    names,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(changes, [
    { name: 'senior-dev', model: 'anthropic/claude-opus-5-5', variant: 'max' },
    { name: 'developer', model: undefined, variant: '' },
  ]);
  for (const model of ['openrouter/anthropic/claude-3.5', 'amazon-bedrock/anthropic.claude-3:0', 'a.b_c-d/e@f']) {
    assert.deepEqual(validateChanges({ changes: [{ name: 'developer', model }] }, names).errors, [], model);
  }
});

test('validateChanges rejects bad names, models, variants and shapes', () => {
  const names = ['senior-dev', 'developer'];
  const bad = (body) => {
    const { errors, changes } = validateChanges(body, names);
    assert.ok(errors.length > 0, JSON.stringify(body));
    assert.deepEqual(changes, []);
    return errors;
  };
  for (const name of ['nope', '../senior-dev', 'senior-dev.md', '.opencode/agents/senior-dev', '', 42, null, '__proto__', 'constructor']) {
    assert.equal(bad({ changes: [{ name, model: 'a/b' }] })[0].field, 'name', String(name));
  }
  for (const model of ['', 'anthropic', '/claude', 'anthropic/', 'a b/c', 'anthropic/claude opus', 'a/b\n', 'a/b\u0000', 'ü/x', 'a'.repeat(199) + '/b', 7, true, {}]) {
    assert.equal(bad({ changes: [{ name: 'developer', model }] })[0].field, 'model', JSON.stringify(model));
  }
  for (const variant of ['ultra', 'HIGH', ' high', 'minimal', 1, false]) {
    assert.equal(bad({ changes: [{ name: 'developer', variant }] })[0].field, 'variant', JSON.stringify(variant));
  }
  bad(null);
  bad({});
  bad({ changes: 'x' });
  bad({ changes: [] });
  bad({ changes: ['developer'] });
  bad({ changes: [{ name: 'developer' }] });
  bad({ changes: [{ name: 'developer', variant: 'low' }, { name: 'developer', variant: 'high' }] });
  // One bad change spoils the batch.
  bad({ changes: [{ name: 'developer', variant: 'low' }, { name: 'senior-dev', model: 'nope' }] });
});

test('parseModelsOutput keeps provider/model lines and drops colours, blanks and log noise', () => {
  const output = [
    '\x1b[1m\x1b[32mModels cache refreshed\x1b[0m',
    'INFO  2026-10-05T10:00:00 +12ms service=models loading cache',
    '',
    '\x1b[0manthropic/claude-opus-5-5\x1b[0m\r',
    '   anthropic/claude-sonnet-5-5   ',
    '\x1b]8;;https://example.com\x07openai/gpt-5.1\x1b]8;;\x07',
    'anthropic/claude-opus-5-5',
    'https://models.dev/api.json',
    '/usr/local/bin/opencode',
    'warning: something / happened',
    'openrouter/anthropic/claude-3.5:beta',
    '',
  ].join('\n');
  assert.deepEqual(parseModelsOutput(output), {
    anthropic: ['anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5'],
    openai: ['openai/gpt-5.1'],
    openrouter: ['openrouter/anthropic/claude-3.5:beta'],
  });
  assert.deepEqual(parseModelsOutput(''), {});
  assert.equal(stripAnsi('\x1b[31mred\x1b[39m'), 'red');
});

test('browserCommands picks the right launcher per platform', () => {
  const url = 'http://127.0.0.1:4317';
  assert.deepEqual(browserCommands(url, { platform: 'win32', env: {} }), [
    { cmd: 'cmd', args: ['/c', 'start', '""', url], options: { windowsVerbatimArguments: true } },
  ]);
  assert.deepEqual(browserCommands(url, { platform: 'darwin', env: {} }), [{ cmd: 'open', args: [url] }]);
  assert.deepEqual(browserCommands(url, { platform: 'linux', env: {}, procVersion: 'Linux version 6.1 (gcc)' }), [{ cmd: 'xdg-open', args: [url] }]);
  const wsl = browserCommands(url, { platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' } });
  assert.deepEqual(wsl.map((c) => c.cmd), ['wslview', 'cmd.exe', 'explorer.exe']);
  assert.deepEqual(wsl[1], { cmd: 'cmd.exe', args: ['/c', 'start', '', url], options: { cwd: '/mnt/c' } });
  assert.equal(wsl[2].anyExit, true);
  const viaProc = browserCommands(url, { platform: 'linux', env: {}, procVersion: 'Linux version 5.15.153.1-microsoft-standard-WSL2' });
  assert.equal(viaProc[0].cmd, 'wslview');
});

test('readAgents and readGlobalConfig read a project; jsonc config gives nulls', async () => {
  const { root, cleanup } = makeProject();
  try {
    const agents = await readAgents(root);
    assert.deepEqual(agents.map((a) => a.name), ['debugger', 'developer', 'platform', 'senior-dev', 'test-reviewer', 'test-writer']);
    assert.deepEqual(agents.find((a) => a.name === 'senior-dev'), {
      name: 'senior-dev',
      file: '.opencode/agents/senior-dev.md',
      description: parseFrontmatter(original['senior-dev.md']).description,
      mode: 'primary',
      hidden: false,
      color: '#7C3AED',
      model: 'anthropic/claude-opus-5-5',
      variant: 'high',
    });
    assert.deepEqual(await readGlobalConfig(root), { model: null, small_model: null, default_agent: 'senior-dev' });
    writeFileSync(path.join(root, 'opencode.json'), '{\n  // a comment\n  "model": "anthropic/x"\n}\n');
    assert.deepEqual(await readGlobalConfig(root), { model: null, small_model: null, default_agent: null });
  } finally {
    cleanup();
  }
});

test('applyChanges is all-or-nothing and writes no temp files behind', async () => {
  const { root, cleanup } = makeProject();
  const dir = path.join(root, '.opencode', 'agents');
  const snapshot = () => Object.fromEntries(readdirSync(dir).map((f) => [f, read(path.join(dir, f))]));
  try {
    const before = snapshot();
    await assert.rejects(
      applyChanges(root, { changes: [{ name: 'developer', variant: 'max' }, { name: 'test-writer', model: 'not a model' }] }),
      (err) => err instanceof ValidationError && err.errors[0].name === 'test-writer',
    );
    assert.deepEqual(snapshot(), before);

    // A file that cannot be rewritten (no frontmatter) also aborts the whole batch.
    writeFileSync(path.join(dir, 'broken.md'), 'just text\n');
    const withBroken = snapshot();
    await assert.rejects(applyChanges(root, { changes: [{ name: 'developer', variant: 'max' }, { name: 'broken', variant: 'low' }] }), /no YAML frontmatter/);
    assert.deepEqual(snapshot(), withBroken);

    const saved = await applyChanges(root, {
      changes: [
        { name: 'developer', model: 'anthropic/claude-opus-5-5', variant: 'xhigh' },
        { name: 'senior-dev', variant: '' },
        { name: 'platform', variant: 'high' }, // unchanged value: not rewritten
      ],
    });
    assert.deepEqual(saved, ['developer', 'senior-dev']);
    const after = snapshot();
    assert.deepEqual(Object.keys(after).sort(), Object.keys(withBroken).sort(), 'no temp files left behind');
    assert.ok(after['platform.md'].equals(withBroken['platform.md']));
    assert.equal(
      after['developer.md'].toString(),
      original['developer.md'].replace('model: anthropic/claude-sonnet-5-5', 'model: anthropic/claude-opus-5-5').replace('variant: medium', 'variant: xhigh'),
    );
    assert.equal(after['senior-dev.md'].toString(), original['senior-dev.md'].replace('variant: high\n', ''));
  } finally {
    cleanup();
  }
});

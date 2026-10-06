import test from 'node:test';
import assert from 'node:assert/strict';

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
});

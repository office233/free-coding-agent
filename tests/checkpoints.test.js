'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCheckpointStore } = require('../lib/checkpoints');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createCheckpointStore(path.join(root, '.cp'));
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  return { store, work, root };
}

test('rewind restores modified files and removes created ones', async (t) => {
  const { store, work } = setup(t);
  const a = path.join(work, 'a.txt');
  const b = path.join(work, 'sub', 'b.txt');
  fs.writeFileSync(a, 'original');
  const cp = await store.record('edit', [a, b]);
  fs.writeFileSync(a, 'changed');
  fs.mkdirSync(path.dirname(b));
  fs.writeFileSync(b, 'new');
  await store.rewind(cp.id);
  assert.equal(fs.readFileSync(a, 'utf8'), 'original');
  assert.equal(fs.existsSync(b), false);
});

test('rewinding an older checkpoint also undoes every later one', async (t) => {
  const { store, work } = setup(t);
  const f = path.join(work, 'f.txt');
  fs.writeFileSync(f, 'v1');
  const first = await store.record('one', [f]);
  fs.writeFileSync(f, 'v2');
  await store.record('two', [f]);
  fs.writeFileSync(f, 'v3');
  const result = await store.rewind(first.id);
  assert.equal(fs.readFileSync(f, 'utf8'), 'v1');
  assert.equal(result.undoneCheckpoints.length, 2);
  assert.equal(store.list().length, 0);
});

test('a deleted directory tree comes back, and the index survives a restart', async (t) => {
  const { store, work, root } = setup(t);
  const dir = path.join(work, 'tree');
  fs.mkdirSync(path.join(dir, 'deep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'deep', 'x.bin'), Buffer.from([0, 1, 2, 255]));
  const cp = await store.record('delete', [dir]);
  fs.rmSync(dir, { recursive: true });
  const reopened = createCheckpointStore(path.join(root, '.cp'));
  assert.equal(reopened.last().id, cp.id);
  await reopened.rewind(cp.id);
  assert.deepEqual([...fs.readFileSync(path.join(dir, 'deep', 'x.bin'))], [0, 1, 2, 255]);
});

test('a corrupt checkpoint index recovers from the previous atomic backup', async (t) => {
  const { store, work, root } = setup(t);
  const file = path.join(work, 'a.txt');
  fs.writeFileSync(file, 'v1');
  const first = await store.record('first', [file]);
  fs.writeFileSync(file, 'v2');
  await store.record('second', [file]); // creates index.prev.json containing the first checkpoint
  fs.writeFileSync(path.join(root, '.cp', 'index.json'), '{broken json');
  const reopened = createCheckpointStore(path.join(root, '.cp'));
  assert.equal(reopened.last().id, first.id);
});

test('legacy checkpoints stay visible but cannot be replayed after a store migration', async (t) => {
  const { store, work, root } = setup(t);
  const file = path.join(work, 'legacy.txt');
  fs.writeFileSync(file, 'safe-current');
  const cp = await store.record('current', [file]);
  const indexFile = path.join(root, '.cp', 'index.json');
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  delete index[0].formatVersion;
  delete index[0].scopeId;
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 1));

  const reopened = createCheckpointStore(path.join(root, '.cp'));
  assert.equal(reopened.list(1)[0].rewindable, false);
  fs.writeFileSync(file, 'must-survive');
  await assert.rejects(() => reopened.rewind(cp.id), /cannot be rewound safely/i);
  assert.equal(fs.readFileSync(file, 'utf8'), 'must-survive');
});

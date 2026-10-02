'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createResourceManager, classifyCommand } = require('../lib/resources');

test('resource manager enforces concurrency slots and releases them', async () => {
  const manager = createResourceManager({
    classes: { heavy: { max: 1, minFreeMB: 100 }, command: { max: 2, minFreeMB: 50 } },
    waitMs: 20,
    pollMs: 2,
    memoryProvider: () => 1024 * 1024 * 1024,
    cpuProvider: () => 0,
  });
  const release = await manager.acquire('heavy');
  await assert.rejects(manager.acquire('heavy'), /Resource admission timed out/);
  release();
  const release2 = await manager.acquire('heavy');
  assert.equal(manager.status().classes.heavy.active, 1);
  release2();
  assert.equal(manager.status().classes.heavy.active, 0);
});

test('resource manager refuses work below its memory watermark', async () => {
  const manager = createResourceManager({
    classes: { command: { max: 1, minFreeMB: 100 } },
    waitMs: 10,
    pollMs: 2,
    memoryProvider: () => 50 * 1024 * 1024,
    cpuProvider: () => 0,
  });
  await assert.rejects(manager.acquire('command'), (error) => error.code === 'RESOURCE_PRESSURE' && /50 MB free/.test(error.message));
});

test('heavy admission can wait longer than the global default without lowering its memory watermark', async () => {
  let samples = 0;
  const manager = createResourceManager({
    classes: { heavy: { max: 1, minFreeMB: 100 } },
    waitMs: 4,
    waitMsByClass: { heavy: 200 },
    pollMs: 2,
    memoryProvider: () => (++samples < 3 ? 50 : 200) * 1024 * 1024,
    cpuProvider: () => 0,
  });
  const release = await manager.acquire('heavy');
  assert.ok(samples >= 3);
  assert.equal(manager.status().classes.heavy.minFreeMB, 100);
  release();
});

test('resource manager gates heavy work under CPU pressure', async () => {
  const manager = createResourceManager({
    classes: { heavy: { max: 1, minFreeMB: 10, maxCpuPercent: 70 } },
    waitMs: 10,
    pollMs: 2,
    memoryProvider: () => 1024 * 1024 * 1024,
    cpuProvider: () => 95,
  });
  await assert.rejects(manager.acquire('heavy'), (error) => error.code === 'RESOURCE_PRESSURE' && /CPU 95%/.test(error.message));
});

test('heavy commands are classified automatically', () => {
  assert.equal(classifyCommand('npm test'), 'heavy');
  assert.equal(classifyCommand('go vet ./...'), 'heavy');
  assert.equal(classifyCommand('ffmpeg -i in.mp4 out.mp4'), 'heavy');
  assert.equal(classifyCommand('node scripts/check.js'), 'command');
});

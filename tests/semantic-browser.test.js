'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const path = require('node:path');
const { chromium } = require('playwright-core');
let browser;
let fixtureServer;
let origin;
  const fixture = `<!doctype html><html><head><title>Isolated browser fixture</title></head><body style="min-height:3000px">
<span id="first">First</span><span id="last">Last</span>
<label for="text">Text input</label><input id="text" value="before">
<input id="aria" aria-labelledby="first last">
<label for="secret">Password</label><input id="secret" type="password" value="fixture-secret-do-not-leak">
<input id="otp" autocomplete="one-time-code" value="654321">
<textarea id="area" aria-label="Message">before</textarea>
<select id="choice" aria-label="Choice"><option value="a">Alpha</option><option value="b">Beta</option></select>
<button id="button" onclick="window.clicks=(window.clicks||0)+1">Action</button>
<input id="readonly" readonly value="immutable"><button id="disabled" disabled>Disabled</button>
<div hidden><button id="hidden">Hidden</button></div><div id="shadow"></div>
<form id="form"><input id="forminput" aria-label="Form input"><button>Submit</button></form>
<script>window.submits=0;document.getElementById('form').addEventListener('submit',e=>{e.preventDefault();window.submits++});document.getElementById('shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow action</button>';</script>
</body></html>`;

before(async () => {
  fixtureServer = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fixture); });
  fixtureServer.listen(0, '127.0.0.1');
  await once(fixtureServer, 'listening');
  origin = `http://127.0.0.1:${fixtureServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => {
  if (browser) await browser.close();
  if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
});
async function setup(t) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.addInitScript(() => {
    window.__messageListeners = [];
    window.chrome = { runtime: { onMessage: { addListener: (listener) => window.__messageListeners.push(listener) } } };
  });
  await page.goto(origin);
  await page.addScriptTag({ path: path.join(__dirname, '../chrome-extension/content.js') });
  return page;
}
const message = (page, request) => page.evaluate((value) => new Promise((resolve) => window.__messageListeners[0](value, {}, resolve)), request);
const snapshot = (page, params = {}) => message(page, { action: 'get_semantic_tree', ...params });
const named = (tree, name) => tree.elements.find((element) => element.name === name);

test('content handshake is versioned and injection is idempotent', async (t) => {
  const page = await setup(t);
  assert.equal((await message(page, { action: 'ping' })).version, 3);
  await page.addScriptTag({ path: path.join(__dirname, '../chrome-extension/content.js') });
  assert.equal(await page.evaluate(() => window.__messageListeners.length), 1);
});
test('passwords and one-time codes are absent from all snapshot outputs', async (t) => {
  const tree = await snapshot(await setup(t));
  assert.ok(!JSON.stringify(tree).includes('fixture-secret-do-not-leak'));
  assert.ok(!JSON.stringify(tree).includes('654321'));
  assert.equal(named(tree, 'Password').value, '[REDACTED]');
});
test('semantic refs remain stable across DOM insertion and repeated snapshots', async (t) => {
  const page = await setup(t);
  const first = await snapshot(page);
  await page.evaluate(() => { const button = document.createElement('button'); button.textContent = 'Inserted'; document.body.prepend(button); });
  const second = await snapshot(page);
  assert.equal(named(first, 'Action').ref, named(second, 'Action').ref);
  assert.notEqual(first.snapshotId, second.snapshotId);
  assert.ok(named(second, 'Inserted').ref > named(second, 'Action').ref);
});
test('stale snapshots and detached refs cannot cause a click', async (t) => {
  const page = await setup(t);
  const first = await snapshot(page);
  const second = await snapshot(page);
  assert.match((await message(page, { action: 'click', ref: named(first, 'Action').ref, snapshotId: first.snapshotId })).error, /STALE_SNAPSHOT/);
  await page.locator('#button').evaluate((element) => element.remove());
  assert.match((await message(page, { action: 'click', ref: named(second, 'Action').ref, snapshotId: second.snapshotId })).error, /STALE_REFERENCE/);
  assert.equal(await page.evaluate(() => window.clicks || 0), 0);
});
test('one semantic click dispatches exactly one click', async (t) => {
  const page = await setup(t);
  const tree = await snapshot(page);
  const result = await message(page, { action: 'click', ref: named(tree, 'Action').ref, snapshotId: tree.snapshotId });
  assert.equal(result.success, true);
  assert.equal(await page.evaluate(() => window.clicks), 1);
});
test('input, textarea and select use their proper native value setters', async (t) => {
  const page = await setup(t);
  const tree = await snapshot(page);
  for (const [name, text, selector] of [['Text input', 'after', '#text'], ['Message', 'message text', '#area'], ['Choice', 'b', '#choice']]) {
    const result = await message(page, { action: 'fill', ref: named(tree, name).ref, text, snapshotId: tree.snapshotId });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(await page.locator(selector).inputValue(), text);
    assert.equal(result.text, undefined);
  }
});
test('disabled and readonly controls reject mutation', async (t) => {
  const page = await setup(t);
  await page.locator('#readonly').evaluate((element) => element.setAttribute('aria-label', 'Read only'));
  const tree = await snapshot(page);
  assert.match((await message(page, { action: 'click', ref: named(tree, 'Disabled').ref })).error, /disabled/);
  assert.match((await message(page, { action: 'fill', ref: named(tree, 'Read only').ref, text: 'overwrite' })).error, /read-only/);
});
test('multiple aria-labelledby IDs, hidden ancestors and open shadow DOM are handled', async (t) => {
  const tree = await snapshot(await setup(t));
  assert.ok(named(tree, 'First Last'));
  assert.ok(named(tree, 'Shadow action'));
  assert.equal(named(tree, 'Hidden'), undefined);
});
test('synthetic Enter reports its limitations and never submits a form unconditionally', async (t) => {
  const page = await setup(t);
  const tree = await snapshot(page);
  const result = await message(page, { action: 'press_key', ref: named(tree, 'Form input').ref, key: 'Enter', snapshotId: tree.snapshotId });
  assert.equal(result.mode, 'synthetic');
  assert.equal(result.nativeDefaultAction, false);
  assert.equal(await page.evaluate(() => window.submits), 0);
});
test('zero scrolling is a no-op and snapshot size is bounded', async (t) => {
  const page = await setup(t);
  const result = await message(page, { action: 'scroll', y: 0 });
  assert.equal(result.scrolled, 0);
  assert.equal(result.scrollY, 0);
  const tree = await snapshot(page, { maxElements: 2 });
  assert.equal(tree.elementCount, 2);
  assert.equal(tree.truncated, true);
});
test('locate returns the element centre for trusted CDP clicks', async (t) => {
  const page = await setup(t);
  const tree = await snapshot(page);
  const button = named(tree, 'Action');
  const box = await message(page, { action: 'locate', ref: button.ref, snapshotId: tree.snapshotId });
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, box);
  assert.equal(hit, 'button');
  assert.equal(box.covered, undefined);
});
test('prepare_input focuses and selects text, or places the caret at the end when appending', async (t) => {
  const page = await setup(t);
  const tree = await snapshot(page);
  const input = named(tree, 'Text input');
  await message(page, { action: 'prepare_input', ref: input.ref, snapshotId: tree.snapshotId });
  assert.deepEqual(await page.evaluate(() => [document.activeElement.id, document.activeElement.selectionStart, document.activeElement.selectionEnd]), ['text', 0, 6]);
  await message(page, { action: 'prepare_input', ref: input.ref, snapshotId: tree.snapshotId, append: true });
  assert.deepEqual(await page.evaluate(() => [document.activeElement.selectionStart, document.activeElement.selectionEnd]), [6, 6]);
  const readonly = tree.elements.find((element) => element.value === 'immutable');
  const result = await message(page, { action: 'prepare_input', ref: readonly.ref, snapshotId: tree.snapshotId });
  assert.match(result.error, /read-only/);
});

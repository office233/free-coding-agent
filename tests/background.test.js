'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../chrome-extension/background.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function fixture() {
  const calls = [];
  const state = { active: 1, documents: { 1: 'document-1', 2: 'document-2' }, snapshots: {}, saved: {}, local: { bridgeToken: '' }, main: [], created: 0 };
  const listeners = [];
  let sequence = 0;
  class FakeSocket {
    static OPEN = 1; static CONNECTING = 0;
    constructor() { this.readyState = 0; this.sent = []; state.socket = this; }
    open() { this.readyState = 1; this.onopen(); }
    send(value) { this.sent.push(JSON.parse(value)); }
    receive(value) { this.onmessage({ data: JSON.stringify(value) }); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const tab = (id) => ({ id, windowId: 1, url: `https://fixture.invalid/tab-${id}`, title: `Tab ${id}` });
  const chrome = {
    runtime: { id: 'fixture-extension', getManifest: () => ({ version: 'fixture', permissions: [] }), onMessage: { addListener: (listener) => listeners.push(listener) }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    storage: {
      local: { setAccessLevel: async (level) => { state.accessLevel = level.accessLevel; }, get: async () => ({ ...state.local }), set: async (value) => { Object.assign(state.local, value); } },
      session: { get: async () => ({}), set: async (value) => { Object.assign(state.saved, value); } },
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    alarms: { create: async () => {}, onAlarm: { addListener() {} } },
    windows: { update: async () => {} },
    tabs: {
      get: async (id) => tab(id), query: async () => [tab(state.active)],
      update: async (id, value) => { if (value.active) state.active = id; return tab(id); },
      create: async () => { state.created++; return tab(3); }, remove: async () => {},
      sendMessage: async (id, request, options) => {
        calls.push({ id, request, options });
        if (options.documentId !== state.documents[id]) throw new Error('The inspected document no longer exists');
        if (request.action === 'ping') return { success: true, version: 3 };
        if (request.action === 'get_semantic_tree') {
          const snapshotId = `${options.documentId}:${++sequence}`;
          state.snapshots[id] = snapshotId;
          return { snapshotId, title: `Tab ${id}`, url: tab(id).url, semanticView: '[#1] button', elements: [{ ref: 1 }], elementCount: 1 };
        }
        if (request.snapshotId !== state.snapshots[id]) return { error: 'STALE_SNAPSHOT' };
        return { success: true, action: request.action };
      },
    },
    scripting: { executeScript: async (request) => {
      if (request.world === 'MAIN') {
        state.main.push(request);
        return [{ result: { tools: [], nativeInvocationSupported: false } }];
      }
      return [{ result: { version: 3 }, documentId: state.documents[request.target.tabId], frameId: 0 }];
    } },
  };
  const context = vm.createContext({
    chrome, WebSocket: FakeSocket, URL, console: { warn() {}, log() {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    window: {}, document: { querySelectorAll: () => [] }, navigator: {},
  });
  vm.runInContext(`${source}\nglobalThis.__api = { handleCommand, pageToolOperation, ready };`, context);
  await context.__api.ready;
  await tick();
  return { api: context.__api, context, state, calls, listeners };
}

test('snapshot discovery runs in MAIN and actions are pinned to a Chrome document ID', async () => {
  const { api, state } = await fixture();
  const tree = await api.handleCommand('get_semantic_tree', { tabId: 1 });
  assert.equal(tree.documentId, 'document-1');
  assert.equal(state.main[0].world, 'MAIN');
  assert.equal(state.main[0].target.documentIds[0], 'document-1');
  assert.equal(state.accessLevel, 'TRUSTED_CONTEXTS');
  assert.equal(state.saved.lastSemanticTarget.snapshotId, tree.snapshotId);
});
test('changing active tabs does not redirect a semantic action', async () => {
  const { api, state, calls } = await fixture();
  const tree = await api.handleCommand('get_semantic_tree', { tabId: 1 });
  state.active = 2;
  await api.handleCommand('click', { ref: 1, snapshotId: tree.snapshotId });
  assert.equal(calls.at(-1).id, 1);
  await assert.rejects(api.handleCommand('click', { ref: 1, tabId: 2, snapshotId: tree.snapshotId }), /another tab/);
});
test('a reloaded document is rejected instead of silently retargeted', async () => {
  const { api, state } = await fixture();
  await api.handleCommand('get_semantic_tree', { tabId: 1 });
  state.documents[1] = 'document-reloaded';
  await assert.rejects(api.handleCommand('click', { ref: 1 }), /no longer exists/);
});
test('JavaScript URLs are rejected before navigation', async () => {
  const { api, state } = await fixture();
  await assert.rejects(api.handleCommand('new_tab', { url: 'javascript:alert(1)' }), /HTTP/);
  assert.equal(state.created, 0);
});
test('command exceptions return an error carrying the original request ID', async () => {
  const { state } = await fixture();
  state.socket.open();
  state.socket.receive({ id: 'error-1', command: 'unsupported', params: {} });
  await tick();
  const reply = state.socket.sent.find((message) => message.id === 'error-1');
  assert.equal(reply.success, false);
  assert.match(reply.error, /Unsupported command/);
});
test('duplicate commands execute once, even while the first request is queued', async () => {
  const { state } = await fixture();
  state.socket.open();
  const command = { id: 'unique-1', command: 'new_tab', params: { url: 'https://fixture.invalid' } };
  state.socket.receive(command);
  state.socket.receive(command);
  await tick();
  assert.equal(state.created, 1);
  assert.equal(state.socket.sent.filter((message) => message.id === 'unique-1').length, 2);
});
test('expired queued commands never mutate the browser', async () => {
  const { state } = await fixture();
  state.socket.open();
  state.socket.receive({ id: 'expired', command: 'new_tab', params: {}, deadlineAt: Date.now() - 10 });
  await tick();
  assert.equal(state.created, 0);
  assert.match(state.socket.sent.find((message) => message.id === 'expired').error, /expired/);
});
test('site tool catalog strips functions and invokes only explicitly declared handlers', async () => {
  const { api, context } = await fixture();
  context.window.mcp = { tools: [{ name: 'sum', description: 'Fixture addition', execute: ({ a, b }) => a + b }] };
  const catalog = await api.pageToolOperation('list');
  assert.equal(catalog.tools[0].name, 'sum');
  assert.equal(catalog.tools[0].execute, undefined);
  assert.equal((await api.pageToolOperation('call', 'sum', { a: 2, b: 3 })).result, 5);
  await assert.rejects(api.pageToolOperation('call', 'constructor', {}), /not declared/);
  await assert.rejects(api.pageToolOperation('call', 'undeclared', {}), /not declared/);
});
test('native WebMCP detection is not misrepresented as native invocation support', async () => {
  const { api, context } = await fixture();
  context.document.modelContext = {};
  const result = await api.pageToolOperation('list');
  assert.equal(result.nativeWebMCPDetected, true);
  assert.equal(result.nativeInvocationSupported, false);
});
test('content scripts cannot access privileged popup commands', async () => {
  const { listeners } = await fixture();
  let replied = false;
  const result = listeners[0]({ action: 'set_bridge_token', token: 'untrusted' }, { id: 'fixture-extension', tab: { id: 1 } }, () => { replied = true; });
  assert.equal(result, false);
  assert.equal(replied, false);
});
test('pairing token can only be stored through the privileged bridge command', async () => {
  const { api, state } = await fixture();
  const token = 'x'.repeat(32);
  const result = await api.handleCommand('set_pairing_token', { token });
  assert.equal(result.stored, true);
  assert.equal(state.local.bridgeToken, token);
  await assert.rejects(api.handleCommand('set_pairing_token', { token: 'short' }), /at least 24/);
});
test('a slow command on one tab does not block another tab, while one tab stays ordered', async () => {
  const { state, context } = await fixture();
  state.socket.open();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const original = context.chrome.tabs.update;
  context.chrome.tabs.update = async (id, value) => { if (id === 1) await gate; return original(id, value); };
  state.socket.receive({ id: 'slow-1', command: 'switch_tab', params: { tabId: 1 } });
  state.socket.receive({ id: 'same-1', command: 'switch_tab', params: { tabId: 1 } });
  state.socket.receive({ id: 'other-2', command: 'switch_tab', params: { tabId: 2 } });
  for (let i = 0; i < 5; i++) await tick();
  const done = () => state.socket.sent.map((m) => m.id).filter(Boolean);
  assert.deepEqual(done(), ['other-2'], 'tab 2 finished while tab 1 is blocked');
  release();
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(done(), ['other-2', 'slow-1', 'same-1'], 'tab 1 commands complete in order');
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createChromeBridge } = require('../lib/chrome-bridge');
const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const TOKEN = 'test-only-not-a-production-credential';

async function setup(t, options = {}) {
  const bridge = createChromeBridge({ port: 0, token: TOKEN, heartbeatMs: 1000, ...options });
  await once(bridge.server, 'listening');
  t.after(() => bridge.close());
  return bridge;
}
async function rawClient(t, bridge, origin = ORIGIN) {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.getStatus().port}`, { origin });
  t.after(() => ws.terminate());
  await once(ws, 'open');
  return ws;
}
async function registered(t, bridge) {
  const ws = await rawClient(t, bridge);
  const registeredMessage = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'register', client: 'chrome_extension', token: TOKEN }));
  assert.equal(JSON.parse((await registeredMessage)[0]).type, 'registered');
  return ws;
}

test('transport refuses non-loopback binding', () => {
  assert.throws(() => createChromeBridge({ host: '0.0.0.0' }), /loopback/);
});
test('offline status and requests are truthful', async (t) => {
  const bridge = await setup(t);
  assert.equal(bridge.getStatus().connected, false);
  assert.equal(bridge.getStatus().authenticationConfigured, true);
  assert.equal((await bridge.sendCommand('list_tabs')).code, 'CHROME_NOT_CONNECTED');
});
test('ordinary website Origin is rejected before upgrade', async (t) => {
  const bridge = await setup(t);
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.getStatus().port}`, { origin: 'https://untrusted.invalid' });
  ws.on('error', () => {});
  const [, response] = await once(ws, 'unexpected-response');
  assert.equal(response.statusCode, 401);
  response.resume();
  ws.terminate();
});
test('wrong registration token is rejected', async (t) => {
  const bridge = await setup(t);
  const ws = await rawClient(t, bridge);
  const closed = once(ws, 'close');
  ws.send(JSON.stringify({ type: 'register', client: 'chrome_extension', token: 'wrong' }));
  assert.equal((await closed)[0], 1008);
  assert.equal(bridge.getStatus().connected, false);
});
test('registered request response is correlated and cleaned up', async (t) => {
  const bridge = await setup(t);
  const ws = await registered(t, bridge);
  ws.on('message', (data) => {
    const message = JSON.parse(data);
    if (message.command) {
      assert.equal(message.command, 'list_tabs');
      assert.ok(message.deadlineAt > Date.now());
      ws.send(JSON.stringify({ id: message.id, success: true, tabs: [{ id: 7 }] }));
    }
  });
  assert.deepEqual((await bridge.sendCommand('list_tabs')).tabs, [{ id: 7 }]);
  assert.equal(bridge.getStatus().pendingRequests, 0);
  assert.equal(bridge.getStatus().metrics.completed, 1);
});
test('failed responses cannot masquerade as success', async (t) => {
  const bridge = await setup(t);
  const ws = await registered(t, bridge);
  ws.on('message', (data) => {
    const message = JSON.parse(data);
    if (message.command) ws.send(JSON.stringify({ id: message.id, success: false }));
  });
  assert.equal((await bridge.sendCommand('click')).code, 'COMMAND_FAILED');
});
test('mutation timeout is indeterminate and clears its pending entry', async (t) => {
  const bridge = await setup(t);
  await registered(t, bridge);
  const result = await bridge.sendCommand('click', { ref: 1 }, 25);
  assert.equal(result.code, 'CHROME_TIMEOUT');
  assert.equal(result.indeterminate, true);
  assert.equal(bridge.getStatus().pendingRequests, 0);
});
test('disconnect resolves pending commands immediately rather than waiting for timeout', async (t) => {
  const bridge = await setup(t);
  const ws = await registered(t, bridge);
  const result = bridge.sendCommand('fill', { ref: 1, text: 'fixture' }, 15000);
  ws.terminate();
  const reply = await result;
  assert.equal(reply.code, 'CHROME_DISCONNECTED');
  assert.equal(reply.indeterminate, true);
  assert.equal(bridge.getStatus().pendingRequests, 0);
});
test('second client cannot take over a registered connection', async (t) => {
  const bridge = await setup(t);
  await registered(t, bridge);
  const second = await rawClient(t, bridge);
  const closed = once(second, 'close');
  second.send(JSON.stringify({ type: 'register', client: 'chrome_extension', token: TOKEN }));
  assert.equal((await closed)[0], 1008);
  assert.equal(bridge.getStatus().connected, true);
});
test('backpressure bounds outstanding commands', async (t) => {
  const bridge = await setup(t, { maxPending: 1 });
  const ws = await registered(t, bridge);
  const first = bridge.sendCommand('list_tabs');
  assert.equal((await bridge.sendCommand('list_tabs')).code, 'BACKPRESSURE');
  ws.terminate();
  await first;
});
test('malformed messages disconnect and settle existing work', async (t) => {
  const bridge = await setup(t);
  const ws = await registered(t, bridge);
  const pending = bridge.sendCommand('list_tabs');
  ws.send('[]');
  assert.equal((await pending).code, 'CHROME_DISCONNECTED');
});
test('application heartbeat is acknowledged without creating a tool response', async (t) => {
  const bridge = await setup(t);
  const ws = await registered(t, bridge);
  const pong = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'ping' }));
  assert.equal(JSON.parse((await pong)[0]).type, 'pong');
  assert.equal(bridge.getStatus().pendingRequests, 0);
});

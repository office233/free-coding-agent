'use strict';

const { randomUUID, timingSafeEqual } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

// Local transport only. Origin filtering is not authentication against local processes;
// set CHROME_BRIDGE_TOKEN and pin CHROME_EXTENSION_ID for stronger client identity.
function createChromeBridge(options = {}) {
  // Configuration comes only from the caller (lib/config.js in production): never read process.env
  // here, so tests and embedders cannot inherit production secrets by accident.
  const port = options.port ?? 3001;
  const host = options.host ?? '127.0.0.1';
  const token = options.token ?? '';
  const extensionId = options.extensionId ?? '';
  const allowedIds = String(extensionId).split(',').map((id) => id.trim()).filter(Boolean);
  const maxPending = options.maxPending ?? 64;
  const heartbeatMs = options.heartbeatMs ?? 20000;
  const registrationTimeoutMs = options.registrationTimeoutMs ?? 5000;
  const pending = new Map();
  let client = null;
  let lastError = null;
  let lastSeenAt = null;
  let closing = false;
  const metrics = { completed: 0, timedOut: 0, disconnected: 0 };
  const readOnly = new Set(['list_tabs', 'get_semantic_tree', 'screenshot', 'get_text', 'console', 'downloads_recent']);

  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid Chrome WS port');
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Chrome bridge must bind to a loopback address');

  const wss = new WebSocketServer({
    host, port, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false,
    verifyClient: ({ origin }) => {
      // CHROME_EXTENSION_ID may list several ids (comma separated), e.g. during a re-install.
      if (allowedIds.length) return allowedIds.some((id) => origin === `chrome-extension://${id}`);
      return !origin || origin.startsWith('chrome-extension://');
    },
  });

  function equalToken(value) {
    if (!token) return true;
    if (typeof value !== 'string') return false;
    const expected = Buffer.from(token);
    const actual = Buffer.from(value);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  function settle(id, result) {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    request.resolve(result);
  }

  function failClient(ws, reason) {
    if (client === ws) client = null;
    for (const [id, request] of pending) {
      if (request.client !== ws) continue;
      metrics.disconnected++;
      settle(id, {
        error: reason, code: 'CHROME_DISCONNECTED',
        indeterminate: !readOnly.has(request.command),
      });
    }
  }

  function send(ws, message) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message), (error) => {
      if (error) { failClient(ws, 'Chrome connection write failed'); ws.terminate(); }
    });
  }

  wss.on('error', (error) => { lastError = error.message; });
  let clientOrigin = null;
  wss.on('connection', (ws, req) => {
    ws.origin = req.headers.origin || null;
    ws.registered = false;
    ws.alive = true;
    const registrationTimer = setTimeout(() => ws.close(1008, 'Registration required'), registrationTimeoutMs);
    registrationTimer.unref?.();
    ws.on('error', () => failClient(ws, 'Chrome connection failed'));
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (data, isBinary) => {
      let message;
      try {
        if (isBinary) throw new Error('Binary messages are unsupported');
        message = JSON.parse(data.toString());
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid message');
      } catch { ws.close(1008, 'Invalid JSON message'); return; }

      if (!ws.registered) {
        if (message.type !== 'register' || message.client !== 'chrome_extension' || !equalToken(message.token)) {
          // Record why (never the token itself) so bridge status can explain a missing connection.
          const reason = message.type !== 'register' ? 'not a registration message'
            : !message.token ? 'the extension sent no pairing token (set it in the extension popup)'
              : 'the extension sent a different pairing token than CHROME_BRIDGE_TOKEN';
          lastError = `Rejected ${ws.origin || 'unknown origin'} at ${new Date().toISOString()}: ${reason}`;
          ws.close(1008, 'Invalid registration'); return;
        }
        if (client && client !== ws && client.readyState === WebSocket.OPEN) {
          ws.close(1008, 'Another Chrome extension is already connected'); return;
        }
        clearTimeout(registrationTimer);
        ws.registered = true;
        client = ws;
        clientOrigin = ws.origin;
        lastError = null;
        lastSeenAt = new Date().toISOString();
        send(ws, { type: 'registered', protocolVersion: 2, heartbeatMs });
        return;
      }

      ws.alive = true;
      lastSeenAt = new Date().toISOString();
      if (message.type === 'ping') { send(ws, { type: 'pong' }); return; }
      if (message.type === 'pong') return;
      const request = pending.get(message.id);
      // A response must belong to the same socket that received the request.
      if (!request || request.client !== ws) return;
      if (typeof message.success !== 'boolean' && typeof message.error !== 'string') {
        settle(message.id, { error: 'Malformed Chrome response', code: 'INVALID_RESPONSE' });
        return;
      }
      metrics.completed++;
      settle(message.id, message.success === false && !message.error
        ? { ...message, error: 'Chrome command failed', code: 'COMMAND_FAILED' }
        : message);
    });
    ws.on('close', () => {
      clearTimeout(registrationTimer);
      failClient(ws, 'Chrome disconnected while the command was running. Inspect state before retrying.');
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { failClient(ws, 'Chrome heartbeat expired'); ws.terminate(); continue; }
      ws.alive = false;
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
        if (ws.registered) send(ws, { type: 'ping' });
      }
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  function sendCommand(command, params = {}, timeoutMs = 15000) {
    if (closing || !client || client.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ error: 'Chrome extension is not connected', code: 'CHROME_NOT_CONNECTED' });
    }
    if (pending.size >= maxPending) {
      return Promise.resolve({ error: 'Chrome command queue is full', code: 'BACKPRESSURE' });
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
      return Promise.resolve({ error: 'Invalid command timeout', code: 'INVALID_TIMEOUT' });
    }
    const ws = client;
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        metrics.timedOut++;
        settle(id, {
          error: `Command ${command} timed out. Inspect state before retrying.`,
          code: 'CHROME_TIMEOUT', indeterminate: !readOnly.has(command),
        });
      }, timeoutMs);
      pending.set(id, { client: ws, command, resolve, timer });
      try { send(ws, { id, command, params, deadlineAt: Date.now() + timeoutMs }); }
      catch (error) { settle(id, { error: error.message, code: 'CHROME_SEND_FAILED' }); }
    });
  }

  function getStatus() {
    return {
      connected: !!client && client.readyState === WebSocket.OPEN,
      listening: !!wss.address(), port: wss.address()?.port ?? port,
      host, protocolVersion: 2, pendingRequests: pending.size,
      authenticationConfigured: !!token, extensionPinned: !!extensionId, clientOrigin,
      lastSeenAt, lastError, metrics: { ...metrics },
    };
  }

  async function close() {
    closing = true;
    clearInterval(heartbeat);
    for (const ws of wss.clients) { failClient(ws, 'Bridge shutting down'); ws.terminate(); }
    await new Promise((resolve) => wss.close(() => resolve()));
  }

  return { sendCommand, getStatus, close, server: wss };
}

module.exports = { createChromeBridge };

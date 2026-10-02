'use strict';

const { timingSafeEqual } = require('node:crypto');
const express = require('express');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const config = require('./lib/config');
const { createChromeBridge } = require('./lib/chrome-bridge');
const { createRegistry } = require('./lib/tools');
const { createMcpServer } = require('./lib/mcp');
const pkg = require('./package.json');

function disabledChromeBridge() {
  return {
    getStatus: () => ({ connected: false, enabled: false }),
    sendCommand: async () => ({ error: 'Chrome bridge is disabled', code: 'CHROME_DISABLED' }),
    close: async () => {},
  };
}

const chromeBridge = config.chrome.enabled ? createChromeBridge(config.chrome) : disabledChromeBridge();
const registry = createRegistry({ chromeBridge });
const app = express();
app.disable('x-powered-by');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function isLoopback(req) {
  const ip = req.socket.remoteAddress || '';
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
}

function viaProxy(req) {
  return !!(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.headers['cf-ray']);
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !config.allowedOrigins.includes(origin)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
  }
  next();
});

app.use((req, _res, next) => {
  console.error(`[http] ${req.method} ${req.path}`);
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok', version: pkg.version }));

function auth(req, res, next) {
  if (config.apiKey) {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ') && safeEqual(header.slice(7), config.apiKey)) return next();
    return res.status(401).json({ error: 'Unauthorized: send Authorization: Bearer <MCP_API_KEY>' });
  }
  if (isLoopback(req) && !viaProxy(req)) return next();
  return res.status(401).json({ error: 'MCP_API_KEY is not configured; only direct loopback requests are allowed' });
}

const parseJson = express.json({ limit: '25mb' });
app.use(auth, parseJson);

const sseSessions = new Map();

app.post('/mcp', async (req, res) => {
  const server = createMcpServer(registry);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('[mcp] request failed:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  }
});

app.get('/mcp', (req, res) => {
  if ((req.headers.accept || '').includes('text/event-stream')) return openSse(req, res);
  return res.status(405).set('Allow', 'POST').json({ error: 'Use POST for Streamable HTTP, or GET /sse for legacy SSE' });
});

app.delete('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').end());

async function openSse(req, res) {
  const server = createMcpServer(registry);
  const transport = new SSEServerTransport('/messages', res);
  sseSessions.set(transport.sessionId, { server, transport });
  res.on('close', () => {
    sseSessions.delete(transport.sessionId);
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
}

app.get('/sse', openSse);

app.post('/messages', async (req, res) => {
  const session = sseSessions.get(String(req.query.sessionId || ''));
  if (!session) return res.status(404).json({ error: 'Unknown or expired SSE session' });
  return session.transport.handlePostMessage(req, res, req.body);
});

app.get('/api/status', (_req, res) => res.json({
  status: 'ok',
  version: pkg.version,
  uptimeSeconds: Math.floor(process.uptime()),
  tools: registry.definitions.length,
  chrome: chromeBridge.getStatus(),
  defaultWorkspace: config.defaultWorkspace,
}));

app.get('/api/tools', (_req, res) => res.json({ tools: registry.definitions }));

app.post('/api/tools/:toolName', async (req, res) => {
  if (!registry.has(req.params.toolName)) {
    return res.status(404).json({ error: `Unknown tool: ${req.params.toolName}` });
  }
  return res.json(await registry.call(req.params.toolName, req.body || {}));
});

app.use('/screenshots', express.static(config.screenshotsDir));
app.use('/clips', express.static(config.clipsDir));

app.use((err, _req, res, next) => {
  console.error('[http] error:', err.message);
  if (res.headersSent) return next(err);
  return res.status(err.status || 500).json({
    error: err.type === 'entity.parse.failed' ? 'Invalid JSON body' : 'Internal error',
  });
});

const httpServer = app.listen(config.port, config.host, (error) => {
  if (error) {
    console.error(`[fatal] Cannot listen on ${config.host}:${config.port}: ${error.code || error.message}`);
    process.exitCode = 1;
    return;
  }
  const address = httpServer.address();
  console.error(`[mcp] HTTP ready on http://${config.host}:${address.port}/mcp with ${registry.definitions.length} tools`);
  console.error('READY');
});

async function shutdown() {
  for (const { server, transport } of sseSessions.values()) {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
  sseSessions.clear();
  await require('./lib/lsp').stopAll();
  await require('./lib/tools/browser').shutdown().catch(() => {});
  await chromeBridge.close().catch(() => {});
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { app, registry, httpServer };

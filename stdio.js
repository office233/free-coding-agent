'use strict';

const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const config = require('./lib/config');
const { createChromeBridge } = require('./lib/chrome-bridge');
const { createRegistry } = require('./lib/tools');
const { createMcpServer } = require('./lib/mcp');

function disabledChromeBridge() {
  return {
    getStatus: () => ({ connected: false, enabled: false }),
    sendCommand: async () => ({ error: 'Chrome bridge is disabled', code: 'CHROME_DISABLED' }),
    close: async () => {},
  };
}

async function main() {
  const chromeBridge = config.chrome.enabled ? createChromeBridge(config.chrome) : disabledChromeBridge();
  const registry = createRegistry({ chromeBridge });
  const server = createMcpServer(registry);
  const transport = new StdioServerTransport();

  const shutdown = async () => {
    await require('./lib/lsp').stopAll();
    await require('./lib/tools/browser').shutdown().catch(() => {});
    await chromeBridge.close().catch(() => {});
    await server.close().catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(transport);
  console.error(`[mcp] stdio ready with ${registry.definitions.length} tools`);
}

main().catch((error) => {
  console.error('[fatal]', error.stack || error.message);
  process.exit(1);
});

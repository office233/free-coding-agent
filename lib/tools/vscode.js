'use strict';

// Language-server data from VS Code via the companion extension (vscode-extension/).
const config = require('../config');
const { json, fail } = require('../util');

async function call(route, params = {}) {
  let res;
  try {
    res = await fetch(`${config.vscodeBridgeUrl}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    return fail(`VS Code bridge not reachable at ${config.vscodeBridgeUrl}. Install/enable vscode-extension and open VS Code. (${error.message})`);
  }
  const body = await res.json().catch(() => ({ error: `Invalid response (HTTP ${res.status})` }));
  if (!res.ok || body.error) return fail(`VS Code: ${body.error || `HTTP ${res.status}`}`);
  return json(body);
}

const position = {
  file: { type: 'string', description: 'Absolute file path' },
  line: { type: 'integer', description: '1-based line' },
  character: { type: 'integer', description: '1-based column' },
};

module.exports = [
  { name: 'vscode_diagnostics', description: 'Live compiler/linter errors and warnings from VS Code language servers (optionally filtered to one file).', inputSchema: { type: 'object', properties: { file: { type: 'string' } } }, annotations: { readOnlyHint: true }, handler: (a) => call('/diagnostics', { file: a.file }) },
  { name: 'vscode_find_references', description: 'All references to the symbol at a position (via the language server).', inputSchema: { type: 'object', properties: position, required: ['file', 'line', 'character'] }, annotations: { readOnlyHint: true }, handler: (a) => call('/references', a) },
  { name: 'vscode_go_to_definition', description: 'Definition location of the symbol at a position.', inputSchema: { type: 'object', properties: position, required: ['file', 'line', 'character'] }, annotations: { readOnlyHint: true }, handler: (a) => call('/definition', a) },
  { name: 'vscode_open_files', description: 'Open editor tabs and the active file in VS Code.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true }, handler: () => call('/open-files') },
  { name: 'vscode_debug_state', description: 'Active debug session and breakpoints.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true }, handler: () => call('/debug-state') },
  { name: 'vscode_add_breakpoint', description: 'Add a breakpoint (optionally conditional).', inputSchema: { type: 'object', properties: { file: position.file, line: position.line, condition: { type: 'string' } }, required: ['file', 'line'] }, handler: (a) => call('/add-breakpoint', a) },
  { name: 'vscode_open_file', description: 'Open a file in VS Code at a line so the user can see it.', inputSchema: { type: 'object', properties: { file: position.file, line: position.line } , required: ['file'] }, handler: (a) => call('/open-file', a) },
];

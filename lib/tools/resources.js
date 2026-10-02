'use strict';

const resources = require('../resources');
const { json } = require('../util');

module.exports = [{
  name: 'resource_status',
  description: 'Current workstation resource pressure and admission-controller slots for commands, builds/tests, LSP, diagnostics, background processes and video work.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async () => json(resources.status()),
}];

// Free Coding Agent extension: bounded command queue, document-scoped actions, MV3 reconnect,
// and trusted input/screenshots through chrome.debugger (CDP) with DOM fallbacks.
'use strict';
const DEFAULT_PORT = 3001;
let socket = null;
let connecting = false;
let reconnectTimer = null;
let retry = 0;
let queue = Promise.resolve(); // tail of the most recent lane (used by the popup)
let queued = 0;
const lanes = new Map(); // lane key -> tail promise
const BROWSER_WIDE = new Set(['list_tabs', 'new_tab', 'downloads_recent', 'extension_info', 'reload_extension']);
/** Commands on the same tab run in order; different tabs (and browser-wide reads) run concurrently. */
function laneFor(command, params) {
  if (BROWSER_WIDE.has(command)) return `browser:${command}`;
  const tabId = params.tabId ?? (params.snapshotId ? targets.get(params.snapshotId)?.tabId : undefined);
  return tabId !== undefined ? `tab:${tabId}` : 'tab:active';
}
let lastTarget = null;
const targets = new Map();
const responses = new Map();
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const saved = await chrome.storage.session.get(['semanticTargets', 'lastSemanticTarget']);
  for (const target of saved.semanticTargets || []) targets.set(target.snapshotId, target);
  lastTarget = saved.lastSemanticTarget || null;
})();

function badge(online) {
  void chrome.action.setBadgeText({ text: online ? 'ON' : 'OFF' }).catch(() => {});
  void chrome.action.setBadgeBackgroundColor({ color: online ? '#10b981' : '#ef4444' }).catch(() => {});
}
function send(ws, message) {
  if (ws === socket && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}
function reconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(30000, 1000 * 2 ** Math.min(retry++, 5)) + Math.random() * 500;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; void connectWebSocket(); }, delay);
}
async function connectWebSocket() {
  if (connecting || (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState))) return;
  connecting = true;
  try {
    await ready;
    const { bridgeToken = '', bridgePort } = await chrome.storage.local.get(['bridgeToken', 'bridgePort']);
    const ws = new WebSocket(`ws://127.0.0.1:${Number(bridgePort) || DEFAULT_PORT}`);
    socket = ws;
    let heartbeat;
    const connectTimeout = setTimeout(() => ws.close(), 10000);
    ws.onopen = () => {
      connecting = false;
      clearTimeout(connectTimeout);
      retry = 0;
      send(ws, { type: 'register', client: 'chrome_extension', protocolVersion: 2, token: bridgeToken });
      heartbeat = setInterval(() => send(ws, { type: 'ping' }), 20000);
    };
    ws.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      if (message.type === 'registered') { ws.registered = true; badge(true); return; }
      if (message.type === 'ping') { send(ws, { type: 'pong' }); return; }
      if (message.type === 'pong') return;
      if (!['string', 'number'].includes(typeof message.id) || typeof message.command !== 'string') return;
      if (responses.has(message.id)) {
        void responses.get(message.id).then((response) => send(ws, response));
        return;
      }
      if (queued >= 64) { send(ws, { id: message.id, success: false, error: 'Command queue full', code: 'BACKPRESSURE' }); return; }
      queued++;
      // One ordered lane per tab: a slow command on one tab no longer blocks the others.
      const lane = laneFor(message.command, message.params || {});
      const previous = lanes.get(lane) || Promise.resolve();
      const execution = previous.then(async () => {
        if (ws !== socket || ws.readyState !== WebSocket.OPEN) throw new Error('Connection closed before execution');
        if (message.deadlineAt && Date.now() >= message.deadlineAt) throw new Error('Command expired before execution');
        return handleCommand(message.command, message.params || {});
      }).then((result) => ({ ...result, id: message.id, success: !result.error && result.success !== false }))
        .catch((error) => ({ id: message.id, success: false, error: error.message, code: error.code || 'COMMAND_FAILED' }));
      responses.set(message.id, execution);
      if (responses.size > 256) responses.delete(responses.keys().next().value);
      const tail = execution.then(() => { queued--; if (lanes.get(lane) === tail) lanes.delete(lane); });
      lanes.set(lane, tail);
      queue = tail;
      void execution.then((response) => send(ws, response));
    };
    ws.onclose = () => {
      clearTimeout(connectTimeout);
      clearInterval(heartbeat);
      if (socket !== ws) return;
      socket = null;
      connecting = false;
      badge(false);
      reconnect();
    };
    ws.onerror = () => { ws.close(); };
  } catch (error) {
    connecting = false;
    badge(false);
    console.warn('[Free Coding Agent] Connection failed:', error.message);
    reconnect();
  }
}

function integer(value, name) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}
function safeUrl(value) {
  if (value === 'about:blank') return value;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) or about:blank navigation is supported');
  return url.href;
}
async function prepareTarget(params) {
  const tab = params.tabId !== undefined
    ? await chrome.tabs.get(integer(params.tabId, 'tabId'))
    : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!tab?.id) throw new Error('No active Chrome tab');
  if (!/^https?:\/\//.test(tab.url || '')) throw new Error('This page cannot be inspected; use an HTTP(S) tab');
  const frameId = integer(params.frameId ?? 0, 'frameId');
  const [probe] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [frameId] }, world: 'ISOLATED',
    func: () => ({ version: window.__free_coding_agent_loaded?.version }),
  });
  if (!probe?.documentId) throw new Error('Could not resolve the current document');
  if (probe.result?.version !== 3) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, documentIds: [probe.documentId] }, files: ['content.js'] });
  }
  const response = await chrome.tabs.sendMessage(tab.id, { action: 'ping' }, { documentId: probe.documentId });
  if (response?.version !== 3) throw new Error('Content script handshake failed');
  return { tabId: tab.id, frameId, documentId: probe.documentId };
}
async function rememberTarget(target) {
  lastTarget = target;
  targets.set(target.snapshotId, target);
  if (targets.size > 64) targets.delete(targets.keys().next().value);
  await chrome.storage.session.set({ semanticTargets: [...targets.values()], lastSemanticTarget: lastTarget });
}
function actionTarget(params) {
  const target = params.snapshotId ? targets.get(params.snapshotId) : lastTarget;
  if (!target) throw new Error('Inspect the target tab before acting; no matching snapshot exists');
  if (params.tabId !== undefined && params.tabId !== target.tabId) throw new Error('Snapshot belongs to another tab; inspect the requested tab first');
  if (params.frameId !== undefined && params.frameId !== target.frameId) throw new Error('Snapshot belongs to another frame');
  return target;
}

// Serialized by Chrome into MAIN world. It must not close over extension variables.
async function pageToolOperation(operation, toolName, args) {
  const entries = new Map();
  const add = (tool, source, receiver) => {
    if (!tool || typeof tool.name !== 'string' || !tool.name || entries.size >= 100) return;
    if (['__proto__', 'constructor', 'prototype'].includes(tool.name) || entries.has(tool.name)) return;
    entries.set(tool.name, { tool, source, receiver });
  };
  for (const tool of Array.isArray(window.mcp?.tools) ? window.mcp.tools : []) add(tool, 'window.mcp', window.mcp);
  for (const tool of Array.isArray(window.__mcp_tools__) ? window.__mcp_tools__ : []) add(tool, 'window.__mcp_tools__', null);
  for (const meta of document.querySelectorAll('meta[name="webmcp-tool"],meta[name="mcp-tool"]')) {
    try { add(JSON.parse(meta.content), 'meta', null); } catch { /* Ignore malformed page metadata. */ }
  }
  if (operation === 'list') {
    const tools = [...entries.values()].map(({ tool, source }) => ({
      name: tool.name.slice(0, 200), description: String(tool.description || '').slice(0, 2000),
      inputSchema: tool.inputSchema || { type: 'object', properties: {} }, source,
    }));
    const serialized = JSON.stringify(tools);
    if (serialized.length > 128000) throw new Error('Site tool metadata exceeds the size limit');
    return { tools: JSON.parse(serialized), nativeWebMCPDetected: !!(document.modelContext || navigator.modelContext), nativeInvocationSupported: false };
  }
  if (operation !== 'call' || !entries.has(toolName)) throw new Error('Site tool is not declared in the current page catalog');
  const { tool, receiver } = entries.get(toolName);
  let result;
  if (typeof tool.execute === 'function') result = await tool.execute.call(tool, args);
  else if (receiver && Object.hasOwn(receiver, toolName) && typeof receiver[toolName] === 'function') result = await receiver[toolName](args);
  else if (receiver && Object.hasOwn(receiver, 'callTool') && typeof receiver.callTool === 'function') result = await receiver.callTool(toolName, args);
  else throw new Error('Declared tool has no supported callable handler; native WebMCP requires a separate adapter');
  const serialized = JSON.stringify(result ?? null);
  if (serialized.length > 1000000) throw new Error('Site tool ran but its result exceeds the size limit; do not blindly retry');
  return { result: JSON.parse(serialized) };
}
async function siteTools(target, operation, toolName, args) {
  const execution = chrome.scripting.executeScript({
    target: { tabId: target.tabId, documentIds: [target.documentId] }, world: 'MAIN',
    func: pageToolOperation, args: [operation, toolName ?? null, args ?? {}],
  });
  let timer;
  try {
    const results = await Promise.race([
      execution,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Site tool timed out; execution may still finish. Inspect before retrying.')), 10000); }),
    ]);
    if (results[0]?.error) throw new Error(results[0].error.message || 'Site script failed');
    if (!results[0]?.result) throw new Error('No serializable response from page tool adapter');
    return results[0].result;
  } finally { clearTimeout(timer); }
}

// ---- chrome.debugger (CDP): trusted input, screenshots, console --------------------
const attached = new Set();
const consoleLogs = new Map();
const pendingDialogs = new Map();
function hasDebugger() { return typeof chrome.debugger?.attach === 'function'; }
async function cdp(tabId, method, params = {}) {
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached.add(tabId);
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable').catch(() => {});
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable').catch(() => {});
  }
  return chrome.debugger.sendCommand({ tabId }, method, params);
}
if (hasDebugger()) {
  chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId));
  chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
    let entry;
    if (method === 'Runtime.consoleAPICalled') {
      entry = { type: params.type, text: (params.args || []).map((a) => a.value ?? a.description ?? '').join(' ') };
    } else if (method === 'Runtime.exceptionThrown') {
      entry = { type: 'exception', text: params.exceptionDetails?.exception?.description || params.exceptionDetails?.text };
    } else if (method === 'Page.javascriptDialogOpening') {
      // Never auto-accept: a confirm() may be destructive. The dialog stays open until the agent
      // decides explicitly (command "dialog"); meanwhile commands on this tab report it.
      pendingDialogs.set(tabId, { type: params.type, message: String(params.message || '').slice(0, 2000), defaultPrompt: params.defaultPrompt || '', url: params.url, time: new Date().toISOString() });
      entry = { type: 'dialog', text: `${params.type}: ${params.message} (waiting for a decision)` };
    } else if (method === 'Page.javascriptDialogClosed') {
      pendingDialogs.delete(tabId);
    }
    if (!entry) return;
    const list = consoleLogs.get(tabId) || [];
    list.push({ time: new Date().toISOString(), ...entry, text: String(entry.text || '').slice(0, 2000) });
    if (list.length > 300) list.splice(0, list.length - 300);
    consoleLogs.set(tabId, list);
  });
}
chrome.tabs.onRemoved?.addListener((tabId) => { attached.delete(tabId); consoleLogs.delete(tabId); pendingDialogs.delete(tabId); });

const KEYS = {
  Enter: [13, 'Enter', '\r'], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Backspace: [8, 'Backspace'], Delete: [46, 'Delete'],
  ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
  Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'], Space: [32, 'Space', ' '],
};
const MODIFIERS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Command: 4, Shift: 8 };
async function cdpKey(tabId, chord) {
  const parts = chord.split('+');
  const name = parts.pop();
  let modifiers = 0;
  for (const part of parts) {
    if (!MODIFIERS[part]) throw new Error(`Unknown modifier ${part}`);
    modifiers |= MODIFIERS[part];
  }
  const known = KEYS[name];
  const single = !known && name.length === 1;
  if (!known && !single && !/^F\d{1,2}$/.test(name)) throw new Error(`Unknown key ${name}`);
  const vk = known ? known[0] : single ? name.toUpperCase().charCodeAt(0) : 111 + Number(name.slice(1));
  const key = name === 'Space' ? ' ' : name;
  const code = known ? known[1] : single && /[a-z]/i.test(name) ? `Key${name.toUpperCase()}` : single && /\d/.test(name) ? `Digit${name}` : name;
  // Text is only produced for unmodified (or shift-only) printable keys, like a real keyboard.
  const text = modifiers & ~MODIFIERS.Shift ? undefined : known ? known[2] : single ? name : undefined;
  const base = { modifiers, key, code, windowsVirtualKeyCode: vk };
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: text ? 'keyDown' : 'rawKeyDown', text });
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}
async function cdpClick(tabId, x, y, clickCount = 1) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (let i = 1; i <= clickCount; i++) {
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: i });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: i });
  }
}
async function evaluateInTab(tabId, expression) {
  const result = await cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
async function resolveTab(params) {
  if (params.tabId !== undefined) return chrome.tabs.get(integer(params.tabId, 'tabId'));
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('No active Chrome tab');
  return tab;
}
function waitForLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(); };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}
async function contentRequest(target, request) {
  const result = await chrome.tabs.sendMessage(target.tabId, { ...request, snapshotId: target.snapshotId }, { documentId: target.documentId });
  if (!result) throw new Error('Content script returned an empty result');
  if (result.error) throw new Error(result.error);
  return result;
}

async function handleCommand(command, params = {}) {
  await ready;
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Invalid command parameters');
  if (command === 'dialog') {
    const tab = await resolveTab(params);
    const pending = pendingDialogs.get(tab.id);
    if (params.action === 'status' || !params.action) return { tabId: tab.id, dialog: pending || null };
    if (!pending) throw new Error('No JavaScript dialog is open on this tab');
    if (!['accept', 'dismiss'].includes(params.action)) throw new Error('action must be accept, dismiss or status');
    await cdp(tab.id, 'Page.handleJavaScriptDialog', { accept: params.action === 'accept', ...(typeof params.promptText === 'string' ? { promptText: params.promptText } : {}) });
    pendingDialogs.delete(tab.id);
    return { success: true, tabId: tab.id, handled: pending, action: params.action };
  }
  // An open dialog blocks the page: report it instead of timing out on every command.
  if (pendingDialogs.size && !['list_tabs', 'extension_info', 'downloads_recent', 'reload_extension', 'new_tab', 'switch_tab'].includes(command)) {
    const tabId = params.tabId ?? (params.snapshotId && targets.get(params.snapshotId)?.tabId) ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
    const pending = pendingDialogs.get(tabId);
    if (pending) {
      const error = new Error(`A JavaScript ${pending.type} dialog is open on tab ${tabId}: "${pending.message.slice(0, 300)}". Decide with chrome_dialog (accept or dismiss) before doing anything else on this tab.`);
      error.code = 'DIALOG_OPEN';
      throw error;
    }
  }
  if (command === 'list_tabs') {
    const tabs = await chrome.tabs.query({});
    return { tabs: tabs.map((tab) => ({ id: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url, active: tab.active, pinned: tab.pinned, status: tab.status })) };
  }
  if (command === 'switch_tab') {
    const tab = await chrome.tabs.update(integer(params.tabId, 'tabId'), { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return { success: true, tabId: tab.id, title: tab.title, url: tab.url };
  }
  if (command === 'new_tab') {
    const tab = await chrome.tabs.create({ url: safeUrl(params.url || 'about:blank'), active: params.active !== false });
    return { success: true, tabId: tab.id, url: tab.url || tab.pendingUrl };
  }
  if (command === 'close_tab') {
    await chrome.tabs.remove(integer(params.tabId, 'tabId'));
    for (const [key, target] of targets) if (target.tabId === params.tabId) targets.delete(key);
    if (lastTarget?.tabId === params.tabId) lastTarget = null;
    await chrome.storage.session.set({ semanticTargets: [...targets.values()], lastSemanticTarget: lastTarget });
    return { success: true, tabId: params.tabId };
  }
  if (command === 'navigate') {
    const url = safeUrl(params.url);
    const current = await resolveTab(params);
    const loaded = chrome.tabs.onUpdated ? waitForLoad(current.id) : Promise.resolve();
    await chrome.tabs.update(current.id, { url });
    await loaded;
    const tab = await chrome.tabs.get(current.id);
    return { success: true, tabId: tab.id, url: tab.url || tab.pendingUrl, title: tab.title, status: tab.status };
  }
  if (command === 'screenshot') {
    const tab = await resolveTab(params);
    if (hasDebugger()) {
      try {
        const shot = await cdp(tab.id, 'Page.captureScreenshot', { format: 'jpeg', quality: 70, fromSurface: true });
        return { tabId: tab.id, url: tab.url, data: shot.data, mimeType: 'image/jpeg' };
      } catch { /* Fall back to captureVisibleTab below. */ }
    }
    if (!tab.active) throw new Error('Tab is not visible; switch to it first (chrome_switch_tab)');
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
    return { tabId: tab.id, url: tab.url, data: dataUrl.split(',')[1], mimeType: 'image/jpeg' };
  }
  if (command === 'evaluate') {
    if (typeof params.expression !== 'string' || !params.expression) throw new Error('expression is required');
    if (!hasDebugger()) throw new Error('chrome.debugger is unavailable; reload the extension after updating it');
    const tab = await resolveTab(params);
    const value = await evaluateInTab(tab.id, params.expression);
    return { tabId: tab.id, result: value === undefined ? null : value };
  }
  if (command === 'get_text') {
    const tab = await resolveTab(params);
    const max = Number.isInteger(params.maxChars) ? params.maxChars : 40000;
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (n) => (document.body?.innerText || '').slice(0, n), args: [max] });
    return { tabId: tab.id, url: tab.url, title: tab.title, text: result?.result || '' };
  }
  if (command === 'reload_extension') {
    // Applies an updated unpacked extension from disk; the bridge reconnects automatically.
    setTimeout(() => chrome.runtime.reload(), 300);
    return { success: true, version: chrome.runtime.getManifest().version, reloading: true };
  }
  if (command === 'extension_info') {
    return { version: chrome.runtime.getManifest().version, permissions: chrome.runtime.getManifest().permissions };
  }
  if (command === 'set_pairing_token') {
    const token = typeof params.token === 'string' ? params.token : '';
    if (token.length > 512 || (token && token.length < 24)) throw new Error('Pairing token must be empty or at least 24 characters');
    await chrome.storage.local.set({ bridgeToken: token });
    return { success: true, stored: true, length: token.length };
  }
  if (command === 'click_at') {
    // Trusted mouse click at viewport coordinates (for UIs that ignore synthetic DOM clicks).
    const tab = await resolveTab(params);
    if (!Number.isFinite(params.x) || !Number.isFinite(params.y)) throw new Error('x and y are required');
    if (!hasDebugger()) throw new Error('chrome.debugger is unavailable; reload the extension');
    if (params.hoverOnly) await cdp(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: params.x, y: params.y });
    else await cdpClick(tab.id, params.x, params.y, params.doubleClick ? 2 : 1);
    return { success: true, tabId: tab.id, x: params.x, y: params.y };
  }
  if (command === 'key') {
    const tab = await resolveTab(params);
    if (typeof params.key !== 'string' || !params.key) throw new Error('key is required');
    await cdpKey(tab.id, params.key);
    return { success: true, tabId: tab.id, key: params.key };
  }
  if (command === 'window') {
    // Bring a tab to the front and give its window a usable size (background tabs freeze some apps).
    const tab = await resolveTab(params);
    await chrome.tabs.update(tab.id, { active: true });
    const update = { focused: true };
    if (Number.isInteger(params.width) && Number.isInteger(params.height)) Object.assign(update, { state: 'normal', width: params.width, height: params.height });
    const win = await chrome.windows.update(tab.windowId, update);
    return { success: true, tabId: tab.id, windowId: win.id, width: win.width, height: win.height, state: win.state };
  }
  if (command === 'set_file_input') {
    // Attach local files to an <input type=file> (upload flows) without the OS file dialog.
    const tab = await resolveTab(params);
    if (typeof params.selector !== 'string' || !Array.isArray(params.files) || !params.files.length) throw new Error('selector and files[] are required');
    const { root } = await cdp(tab.id, 'DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdp(tab.id, 'DOM.querySelector', { nodeId: root.nodeId, selector: params.selector });
    if (!nodeId) throw new Error(`No element matches ${params.selector}`);
    await cdp(tab.id, 'DOM.setFileInputFiles', { nodeId, files: params.files.map(String) });
    return { success: true, tabId: tab.id, files: params.files.length };
  }
  if (command === 'downloads_recent') {
    if (!chrome.downloads?.search) throw new Error('downloads permission missing; reload the extension');
    const items = await chrome.downloads.search({
      orderBy: ['-startTime'], limit: Math.min(Number(params.limit) || 10, 50),
      ...(params.since ? { startedAfter: new Date(params.since).toISOString() } : {}),
    });
    // url/finalUrl/referrer let the bridge prove where a file came from (provenance).
    return { downloads: items.map((d) => ({ id: d.id, filename: d.filename, state: d.state, error: d.error, mime: d.mime, bytes: d.totalBytes, startTime: d.startTime, endTime: d.endTime, url: String(d.url || '').slice(0, 300), finalUrl: String(d.finalUrl || '').slice(0, 300), referrer: String(d.referrer || '').slice(0, 300) })) };
  }
  if (command === 'console') {
    const tab = await resolveTab(params);
    // Attaching starts capture; earlier messages cannot be recovered.
    if (hasDebugger() && !attached.has(tab.id)) await cdp(tab.id, 'Runtime.enable').catch(() => {});
    const logs = consoleLogs.get(tab.id) || [];
    if (params.clear) consoleLogs.delete(tab.id);
    return { tabId: tab.id, logs, capturing: attached.has(tab.id) };
  }
  if (command === 'get_semantic_tree') {
    const target = await prepareTarget(params);
    const result = await chrome.tabs.sendMessage(target.tabId, { action: command, maxElements: params.maxElements }, { documentId: target.documentId });
    if (!result || result.error) throw new Error(result?.error || 'No semantic response');
    let catalog;
    try { catalog = await siteTools(target, 'list'); }
    catch (error) { catalog = { tools: [], warning: error.message }; }
    const scoped = { ...target, snapshotId: result.snapshotId };
    await rememberTarget(scoped);
    return { ...result, ...scoped, siteTools: catalog.tools, siteToolCapabilities: catalog };
  }
  if (['click', 'fill', 'press_key', 'scroll', 'call_site_tool'].includes(command)) {
    const target = actionTarget(params);
    if (command === 'call_site_tool') {
      // Verify that the same content document is still alive before invoking page code.
      await chrome.tabs.sendMessage(target.tabId, { action: 'ping' }, { documentId: target.documentId });
      return { success: true, ...await siteTools(target, 'call', params.toolName, params.args) };
    }
    if (hasDebugger() && target.frameId === 0 && ['click', 'fill', 'press_key'].includes(command)) {
      try { return { ...await trustedAction(command, target, params), tabId: target.tabId, frameId: target.frameId }; }
      catch (error) { if (error.stage !== 'debugger') throw error; }
    }
    const result = await chrome.tabs.sendMessage(target.tabId, { ...params, action: command, snapshotId: target.snapshotId }, { documentId: target.documentId });
    if (!result) throw new Error('Content script returned an empty result');
    return { ...result, tabId: target.tabId, frameId: target.frameId, mode: 'synthetic' };
  }
  throw new Error(`Unsupported command: ${command}`);
}

// The content script resolves and validates the ref (snapshot, visibility, disabled);
// the input itself goes through CDP so pages receive trusted events.
async function trustedAction(command, target, params) {
  const viaDebugger = async (fn) => {
    try { return await fn(); } catch (error) { error.stage = 'debugger'; throw error; }
  };
  if (command === 'click') {
    const box = await contentRequest(target, { action: 'locate', ref: params.ref });
    await viaDebugger(() => cdpClick(target.tabId, box.x, box.y, params.doubleClick ? 2 : 1));
    return { success: true, action: 'click', ref: params.ref, mode: 'trusted' };
  }
  if (command === 'fill') {
    if (typeof params.text !== 'string') throw new Error('text must be a string');
    await contentRequest(target, { action: 'prepare_input', ref: params.ref, append: !!params.append });
    await viaDebugger(async () => {
      if (params.text) await cdp(target.tabId, 'Input.insertText', { text: params.text });
      else if (!params.append) await cdpKey(target.tabId, 'Backspace');
      if (params.submit) await cdpKey(target.tabId, 'Enter');
    });
    return { success: true, action: 'fill', ref: params.ref, textLength: params.text.length, submitted: !!params.submit, mode: 'trusted' };
  }
  if (typeof params.key !== 'string' || !params.key) throw new Error('key is required');
  if (params.ref !== undefined) await contentRequest(target, { action: 'locate', ref: params.ref });
  await viaDebugger(() => cdpKey(target.tabId, params.key));
  return { success: true, key: params.key, mode: 'trusted' };
}

chrome.runtime.onMessage.addListener((request, sender, reply) => {
  // Never expose privileged routing to content scripts or to page postMessage.
  if (sender.id !== chrome.runtime.id || sender.tab) return false;
  if (request?.action === 'bridge_status') {
    reply({ connected: socket?.readyState === WebSocket.OPEN && socket.registered === true, queued, version: 2 });
    return false;
  }
  if (request?.action === 'inspect_tab') {
    const execution = queue.then(() => handleCommand('get_semantic_tree', { tabId: request.tabId }));
    queue = execution.catch(() => {});
    void execution.then(reply, (error) => reply({ error: error.message }));
    return true;
  }
  if (request?.action === 'set_bridge_token' && typeof request.token === 'string' && request.token.length <= 512) {
    const port = request.port === undefined || request.port === '' ? DEFAULT_PORT : Number(request.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) { reply({ error: 'Invalid port' }); return false; }
    void ready.then(() => chrome.storage.local.set({ bridgeToken: request.token, bridgePort: port })).then(() => {
      socket?.close();
      reply({ success: true });
      void connectWebSocket();
    }, (error) => reply({ error: error.message }));
    return true;
  }
  return false;
});
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'free-coding-agent-reconnect') void connectWebSocket(); });
chrome.runtime.onStartup.addListener(() => { void chrome.alarms.create('free-coding-agent-reconnect', { periodInMinutes: 1 }); void connectWebSocket(); });
chrome.runtime.onInstalled.addListener(() => { void chrome.alarms.create('free-coding-agent-reconnect', { periodInMinutes: 1 }); void connectWebSocket(); });
void chrome.alarms.create('free-coding-agent-reconnect', { periodInMinutes: 1 });
void connectWebSocket();

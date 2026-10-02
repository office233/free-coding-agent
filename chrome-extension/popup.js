'use strict';
const tabInfo = document.getElementById('tabInfo');
const siteTools = document.getElementById('siteTools');
const statusBadge = document.getElementById('statusBadge');
const inspectButton = document.getElementById('inspectBtn');
const endpoint = document.getElementById('endpoint');
const DEFAULT_PORT = 3001;

async function showEndpoint() {
  const { bridgePort, bridgeToken = '' } = await chrome.storage.local.get(['bridgePort', 'bridgeToken']);
  // Show whether a pairing token is stored (its length only, never the value).
  endpoint.textContent = `ws://127.0.0.1:${Number(bridgePort) || DEFAULT_PORT} · pairing token: ${bridgeToken ? `set (${bridgeToken.length} chars)` : 'not set'}`;
  return Number(bridgePort) || DEFAULT_PORT;
}

async function refreshStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let host = '';
    try { host = new URL(tab?.url || '').hostname; } catch { /* Restricted or empty tab. */ }
    tabInfo.textContent = tab ? `${tab.title || 'Untitled'}${host ? ` (${host})` : ''}` : 'No active tab';
    const status = await chrome.runtime.sendMessage({ action: 'bridge_status' });
    statusBadge.textContent = status?.connected ? 'Connected' : 'Offline';
    statusBadge.className = `badge ${status?.connected ? 'connected' : 'disconnected'}`;
  } catch (error) {
    statusBadge.textContent = 'Unavailable';
    statusBadge.className = 'badge disconnected';
    tabInfo.textContent = error.message;
  }
}

// Opening the popup must not rebuild the snapshot used by a running agent.
siteTools.textContent = 'Press Inspect to read this tab. Existing agent references remain unchanged until then.';
inspectButton.addEventListener('click', async () => {
  inspectButton.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');
    const result = await chrome.runtime.sendMessage({ action: 'inspect_tab', tabId: tab.id });
    if (!result || result.error) throw new Error(result?.error || 'No inspection response');
    const tools = result.siteTools || [];
    // Page-owned descriptions are untrusted text, never HTML.
    siteTools.replaceChildren();
    const summary = document.createElement('div');
    summary.textContent = `${result.elementCount} elements${result.truncated ? ' (truncated)' : ''}; ${tools.length} declared site tools.`;
    siteTools.append(summary);
    for (const tool of tools) {
      const line = document.createElement('div');
      line.textContent = `${tool.name}: ${tool.description || ''}`;
      siteTools.append(line);
    }
    if (result.siteToolCapabilities?.warning) {
      const warning = document.createElement('div');
      warning.textContent = result.siteToolCapabilities.warning;
      siteTools.append(warning);
    }
  } catch (error) { siteTools.textContent = error.message; }
  finally { inspectButton.disabled = false; await refreshStatus(); }
});

// Token settings live only in the extension UI; no web page can access this route.
const settings = document.createElement('details');
settings.style.marginTop = '12px';
const title = document.createElement('summary');
title.textContent = 'Local bridge pairing';
const form = document.createElement('form');
const label = document.createElement('label');
  label.textContent = 'CHROME_BRIDGE_TOKEN (required for secure pairing; must match .env)';
label.htmlFor = 'bridgeToken';
const input = document.createElement('input');
input.id = 'bridgeToken';
input.type = 'password';
input.autocomplete = 'off';
input.maxLength = 512;
input.style.width = '100%';
input.style.boxSizing = 'border-box';
const portLabel = document.createElement('label');
portLabel.textContent = 'CHROME_WS_PORT';
portLabel.htmlFor = 'bridgePort';
const portInput = document.createElement('input');
portInput.id = 'bridgePort';
portInput.type = 'number';
portInput.min = '1';
portInput.max = '65535';
portInput.style.width = '100%';
portInput.style.boxSizing = 'border-box';
void showEndpoint().then((port) => { portInput.value = String(port); });
// Unpaired: show the pairing form expanded and at the top, so it cannot be missed.
void chrome.storage.local.get('bridgeToken').then(({ bridgeToken }) => {
  if (bridgeToken) return;
  settings.open = true;
  document.body.prepend(settings);
  input.placeholder = 'Paste the token here (Ctrl+V)';
  input.focus();
});
const save = document.createElement('button');
save.type = 'submit';
save.textContent = 'Save and reconnect';
const feedback = document.createElement('p');
feedback.setAttribute('role', 'status');
form.append(portLabel, portInput, label, input, save, feedback);
settings.append(title, form);
document.body.append(settings);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!input.value.trim() && !event.submitter?.dataset.clear) {
    feedback.textContent = 'The token field is empty — paste the token (Ctrl+V) first.';
    return;
  }
  save.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ action: 'set_bridge_token', token: input.value, port: portInput.value });
    if (!response?.success) throw new Error(response?.error || 'Could not save token');
    input.value = '';
    feedback.textContent = 'Saved. The extension is reconnecting.';
    await showEndpoint();
  } catch (error) { feedback.textContent = error.message; }
  finally { save.disabled = false; }
});
void refreshStatus();

// Free Coding Agent semantic DOM adapter. This is not the browser's native AX tree.
// Older copies left behind by an extension reload are orphaned (no runtime connection),
// so a newer version simply installs itself alongside them.
(() => {
  'use strict';
  const VERSION = 3;
  if (window.__free_coding_agent_loaded?.version === VERSION) return;
  window.__free_coding_agent_loaded = { version: VERSION };

  const documentToken = crypto.randomUUID();
  const refIds = new WeakMap();
  let elementRegistry = new Map();
  let nextRefId = 1;
  let snapshotSequence = 0;
  let snapshotId = null;
  const selector = [
    'a[href]', 'button', 'input', 'textarea', 'select', 'summary',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="tab"]', '[role="menuitem"]', '[role="combobox"]', '[role="textbox"]',
    '[contenteditable]:not([contenteditable="false"])', 'h1', 'h2', 'h3',
  ].join(',');

  const cleanText = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  function isVisible(el) {
    if (!el?.isConnected || el.nodeType !== Node.ELEMENT_NODE) return false;
    for (let parent = el; parent; parent = parent.parentElement || parent.getRootNode()?.host) {
      const style = getComputedStyle(parent);
      if (parent.hidden || parent.inert || parent.getAttribute('aria-hidden') === 'true' ||
          style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
          Number(style.opacity) === 0) return false;
    }
    return el.getClientRects().length > 0;
  }

  function getAccessibleName(el) {
    const ids = (el.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
    if (ids.length) {
      const root = el.getRootNode();
      const label = ids.map((id) => root.getElementById?.(id)?.textContent || '').join(' ');
      if (cleanText(label)) return cleanText(label);
    }
    if (el.getAttribute('aria-label')?.trim()) return cleanText(el.getAttribute('aria-label'));
    if (el.labels?.length) return cleanText(Array.from(el.labels, (label) => label.textContent).join(' '));
    if (el.placeholder) return cleanText(el.placeholder);
    if (el.alt) return cleanText(el.alt);
    if (el.title) return cleanText(el.title);
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) return cleanText(el.value);
    // Do not derive a textarea's name from its initial (possibly sensitive) value.
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return '';
    return cleanText(el.innerText || el.textContent);
  }

  function isSensitive(el) {
    return el.type === 'password' || /(?:password|one-time-code|cc-number|cc-csc)/i.test(el.autocomplete || '');
  }

  function buildSemanticTree(options = {}) {
    const requestedLimit = options.maxElements ?? 500;
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 2000) {
      throw new Error('maxElements must be an integer between 1 and 2000');
    }
    const registry = new Map();
    const items = [];
    let visited = 0;
    let truncated = false;
    snapshotId = `${documentToken}:${++snapshotSequence}`;

    function scan(root) {
      for (const el of root.querySelectorAll('*')) {
        if (++visited > 30000 || items.length >= requestedLimit) { truncated = true; break; }
        if (el.matches(selector) && isVisible(el)) {
          let ref = refIds.get(el);
          if (!ref) { ref = nextRefId++; refIds.set(el, ref); }
          registry.set(ref, el);
          const tag = el.tagName.toLowerCase();
          const rect = el.getBoundingClientRect();
          const inputRole = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button' };
          const role = el.getAttribute('role') || ({ a: 'link', input: inputRole[el.type] || 'textbox', textarea: 'textbox', select: 'combobox' }[tag] || tag);
          const sensitive = isSensitive(el);
          const value = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
            ? (sensitive ? '[REDACTED]' : String(el.value || '').slice(0, 500)) : undefined;
          items.push({
            ref, tag, role, name: getAccessibleName(el), type: el.type || undefined,
            value: value || undefined, sensitive: sensitive || undefined,
            checked: ['checkbox', 'radio'].includes(el.type) ? el.checked : el.getAttribute('aria-checked') ?? undefined,
            disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true' || undefined,
            readOnly: el.readOnly || undefined,
            expanded: el.getAttribute('aria-expanded') ?? undefined,
            selected: el.getAttribute('aria-selected') ?? undefined,
            href: el.href || undefined,
            bounds: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
          });
        }
        if (el.shadowRoot) scan(el.shadowRoot);
        if (truncated) break;
      }
    }
    scan(document);
    elementRegistry = registry;
    const semanticView = items.map((item) => {
      let line = `[#${item.ref}] ${item.role}`;
      if (item.name) line += ` ${JSON.stringify(item.name)}`;
      if (item.value) line += ` (value: ${JSON.stringify(item.value)})`;
      if (item.checked !== undefined) line += ` (checked: ${item.checked})`;
      if (item.disabled) line += ' [DISABLED]';
      if (item.href) line += ` -> ${item.href}`;
      return line;
    }).join('\n');
    return {
      title: document.title, url: location.href, documentToken, snapshotId,
      elementCount: items.length, truncated, elements: items, semanticView,
      siteTools: [], // The service worker discovers page-owned APIs in MAIN world.
      capabilities: { openShadowRoots: true, nativeAccessibilityTree: false, trustedKeyboardEvents: false },
    };
  }

  function getElement(ref, expectedSnapshot, editable = false) {
    if (expectedSnapshot && expectedSnapshot !== snapshotId) throw new Error('STALE_SNAPSHOT: inspect this tab again');
    if (!Number.isInteger(ref) || ref < 1) throw new Error('Invalid semantic reference');
    const el = elementRegistry.get(ref);
    if (!el?.isConnected) throw new Error(`STALE_REFERENCE: #${ref} is no longer attached; inspect again`);
    if (!isVisible(el)) throw new Error(`Element #${ref} is hidden`);
    if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') throw new Error(`Element #${ref} is disabled`);
    if (editable && (el.readOnly || el.getAttribute('aria-readonly') === 'true')) throw new Error(`Element #${ref} is read-only`);
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    el.focus?.({ preventScroll: true });
    return el;
  }

  function performClick(request) {
    const el = getElement(request.ref, request.snapshotId);
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
    return { success: true, action: 'click', ref: request.ref, tagName: el.tagName, verification: 'event-dispatched' };
  }

  function performFill(request) {
    if (typeof request.text !== 'string' || request.text.length > 1000000) throw new Error('text must be a string of at most 1,000,000 characters');
    const el = getElement(request.ref, request.snapshotId, true);
    const tag = el.tagName;
    const blocked = ['file', 'checkbox', 'radio', 'button', 'submit', 'reset', 'hidden'];
    if (tag === 'INPUT' && blocked.includes(el.type)) throw new Error(`Input type ${el.type} cannot be filled as text`);
    const prototype = { INPUT: HTMLInputElement.prototype, TEXTAREA: HTMLTextAreaElement.prototype, SELECT: HTMLSelectElement.prototype }[tag];
    if (!prototype && !el.isContentEditable) throw new Error('Target is not editable');
    if (tag === 'SELECT' && !Array.from(el.options).some((option) => option.value === request.text && !option.disabled && !option.parentElement?.disabled)) {
      throw new Error('No enabled select option matches the requested value');
    }
    if (!el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: request.text }))) {
      throw new Error('Page cancelled the input operation');
    }
    if (prototype) Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, request.text);
    else el.textContent = request.text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: request.text }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return { success: true, action: 'fill', ref: request.ref, textLength: request.text.length, verification: 'value-set-and-events-dispatched' };
  }

  function performPressKey(request) {
    if (typeof request.key !== 'string' || !request.key || request.key.length > 80) throw new Error('Invalid key');
    if (request.snapshotId && request.snapshotId !== snapshotId) throw new Error('STALE_SNAPSHOT: inspect this tab again');
    const el = request.ref !== undefined ? getElement(request.ref, request.snapshotId) : document.activeElement;
    if (!el) throw new Error('No focused element');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: request.key, bubbles: true, cancelable: true, composed: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: request.key, bubbles: true, cancelable: true, composed: true }));
    // Synthetic KeyboardEvents do not perform native typing, Tab navigation or Enter submission.
    return { success: true, key: request.key, mode: 'synthetic', nativeDefaultAction: false, verification: 'events-dispatched' };
  }

  // Viewport coordinates of the element centre, for trusted CDP mouse input.
  function locate(request) {
    const el = getElement(request.ref, request.snapshotId);
    const rect = el.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    // Make sure the click would land on the element (not on an overlay covering it).
    const hit = document.elementFromPoint(x, y);
    const covered = hit && hit !== el && !el.contains(hit) && !hit.contains(el);
    return { success: true, ref: request.ref, x, y, covered: covered || undefined, coveredBy: covered ? hit.tagName.toLowerCase() : undefined };
  }

  // Focus an editable element and select its content (or move the caret to the end) before CDP text insertion.
  function prepareInput(request) {
    const el = getElement(request.ref, request.snapshotId, true);
    const textual = (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'hidden', 'range', 'color'].includes(el.type)) || el.tagName === 'TEXTAREA';
    if (!textual && !el.isContentEditable) throw new Error('Target is not a text field; use click for other controls');
    el.focus();
    if (textual) {
      try {
        if (request.append) el.setSelectionRange(el.value.length, el.value.length);
        else el.select();
      } catch { if (!request.append) el.select?.(); } // email/number inputs do not support ranges.
    } else {
      const range = document.createRange();
      range.selectNodeContents(el);
      if (request.append) range.collapse(false);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return { success: true, ref: request.ref };
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || typeof request.action !== 'string') return false;
    try {
      switch (request.action) {
        case 'ping': sendResponse({ success: true, version: VERSION, documentToken }); break;
        case 'locate': sendResponse(locate(request)); break;
        case 'prepare_input': sendResponse(prepareInput(request)); break;
        case 'get_semantic_tree': sendResponse(buildSemanticTree(request)); break;
        case 'click': sendResponse(performClick(request)); break;
        case 'fill': sendResponse(performFill(request)); break;
        case 'press_key': sendResponse(performPressKey(request)); break;
        case 'scroll': {
          if (request.snapshotId && request.snapshotId !== snapshotId) throw new Error('STALE_SNAPSHOT: inspect this tab again');
          const y = request.y ?? 500;
          if (!Number.isFinite(y) || Math.abs(y) > 100000) throw new Error('Invalid scroll distance');
          window.scrollBy({ top: y, behavior: 'instant' });
          sendResponse({ success: true, scrolled: y, scrollX: window.scrollX, scrollY: window.scrollY });
          break;
        }
        default: sendResponse({ error: `Unsupported content action: ${request.action}`, code: 'UNSUPPORTED_ACTION' });
      }
    } catch (error) { sendResponse({ error: error.message, code: 'CONTENT_ACTION_FAILED' }); }
    return false;
  });
})();

'use strict';

const { text, json, fail, truncate, requireString } = require('../util');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

function decodeEntities(s) {
  return s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

async function webSearch(args) {
  const query = requireString(args, 'query');
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return fail(`Search failed: HTTP ${res.status}`);
  const html = await res.text();
  const results = [];
  for (const block of html.split(/class="result results_links/).slice(1)) {
    const link = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    let url = decodeEntities(link[1]);
    const redirect = url.match(/[?&]uddg=([^&]+)/);
    if (redirect) url = decodeURIComponent(redirect[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    results.push({ title: stripTags(link[2]), url, snippet: snippet ? stripTags(snippet[1]) : '' });
    if (results.length >= 10) break;
  }
  if (!results.length) return fail('No results (DuckDuckGo may be rate limiting). Try browser_navigate to a search engine instead.');
  return json({ query, results });
}

function htmlToText(html) {
  return decodeEntities(html
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|pre|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
}

async function fetchUrl(args) {
  const url = requireString(args, 'url');
  if (!/^https?:\/\//i.test(url)) return fail('Only http(s) URLs are supported');
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/json,text/plain,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  const type = res.headers.get('content-type') || '';
  // Stream with a hard cap: a huge response must not be buffered whole.
  const MAX_BYTES = 5 * 1024 * 1024;
  const chunks = [];
  let received = 0;
  let capped = false;
  const reader = res.body ? res.body.getReader() : null;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > MAX_BYTES) { capped = true; chunks.push(value.subarray(0, value.length - (received - MAX_BYTES))); await reader.cancel(); break; }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks).toString('utf8') + (capped ? '\n[response truncated at 5 MB]' : '');
  const content = /html/i.test(type) && !args.raw ? htmlToText(body) : body;
  const max = Number.isInteger(args.maxChars) ? args.maxChars : 40000;
  return text(`URL: ${res.url}\nStatus: ${res.status}\nContent-Type: ${type}\n\n${truncate(content, max)}`, res.ok ? {} : { isError: true });
}

module.exports = [
  { name: 'web_search', description: 'Search the web (DuckDuckGo). Returns title, url, snippet for the top results.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: true, openWorldHint: true }, handler: webSearch },
  {
    name: 'fetch_url',
    description: 'Fetch a URL (follows redirects) and return readable text. raw: true returns the unprocessed body (useful for JSON/APIs).',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, raw: { type: 'boolean' }, maxChars: { type: 'integer', default: 40000 } }, required: ['url'] },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: fetchUrl,
  },
];

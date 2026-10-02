'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function configDir(env = process.env) {
  if (env.FREE_CODING_AGENT_CONFIG_DIR) return path.resolve(env.FREE_CODING_AGENT_CONFIG_DIR);
  if (process.platform === 'win32') {
    return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'free-coding-agent');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'free-coding-agent');
}

function dataDir(env = process.env) {
  if (env.FREE_CODING_AGENT_HOME) return path.resolve(env.FREE_CODING_AGENT_HOME);
  if (process.platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'free-coding-agent');
  }
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'free-coding-agent');
}

function configFile(env = process.env) {
  return env.FREE_CODING_AGENT_CONFIG
    ? path.resolve(env.FREE_CODING_AGENT_CONFIG)
    : path.join(configDir(env), 'config.env');
}

function quoteEnv(value) {
  const text = String(value ?? '');
  if (!text || /^[A-Za-z0-9_./:\\-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

function updateEnvFile(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const lines = text ? text.split(/\r?\n/) : [];
  const seen = new Set();
  const next = lines.map((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (!match || !Object.prototype.hasOwnProperty.call(values, match[1])) return line;
    const key = match[1];
    seen.add(key);
    return `${key}=${quoteEnv(values[key])}`;
  });

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) next.push(`${key}=${quoteEnv(value)}`);
  }

  fs.writeFileSync(file, `${next.filter((line, index) => line || index < next.length - 1).join('\n').trimEnd()}\n`, 'utf8');
}

module.exports = { configDir, dataDir, configFile, updateEnvFile };

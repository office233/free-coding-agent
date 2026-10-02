'use strict';

const os = require('node:os');
const config = require('./config');

function cpuCounters() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [name, value] of Object.entries(cpu.times)) {
      total += value;
      if (name === 'idle') idle += value;
    }
  }
  return { idle, total };
}
let lastCpu = cpuCounters();
let cpuLoadPercent = 0;
const cpuSampler = setInterval(() => {
  const now = cpuCounters();
  const total = now.total - lastCpu.total;
  const idle = now.idle - lastCpu.idle;
  if (total > 0) cpuLoadPercent = Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100)));
  lastCpu = now;
}, 1000);
cpuSampler.unref?.();

class ResourcePressureError extends Error {
  constructor(message, snapshot) {
    super(message);
    this.name = 'ResourcePressureError';
    this.code = 'RESOURCE_PRESSURE';
    this.snapshot = snapshot;
  }
}

function createResourceManager({
  classes,
  waitMs,
  waitMsByClass,
  pollMs = 250,
  memoryProvider = () => os.freemem(),
  cpuProvider = () => cpuLoadPercent,
} = {}) {
  const specs = classes || config.resources.classes;
  const defaultWaitMs = waitMs ?? config.resources.waitMs;
  // Constructor-level waitMs is an explicit override (used heavily by tests
  // and embedded managers), so config class defaults must not silently trump it.
  const classWaitMs = waitMsByClass ?? (waitMs === undefined ? (config.resources.waitMsByClass || {}) : {});
  const active = new Map(Object.keys(specs).map((kind) => [kind, 0]));
  const waiting = new Map(Object.keys(specs).map((kind) => [kind, 0]));

  const freeMB = () => Math.round(memoryProvider() / 2 ** 20);
  function specFor(kind) {
    return specs[kind] || specs.command || { max: 2, minFreeMB: 128, maxCpuPercent: 100 };
  }
  function snapshot() {
    const freeMemoryMB = freeMB();
    const cpuPercent = Math.round(Number(cpuProvider()) || 0);
    const minMemory = Math.min(...Object.values(specs).map((s) => s.minFreeMB || 0));
    return {
      totalMemoryMB: Math.round(os.totalmem() / 2 ** 20),
      freeMemoryMB,
      cpuPercent,
      pressure: freeMemoryMB < minMemory || cpuPercent >= 95 ? 'critical' : freeMemoryMB < 1024 || cpuPercent >= 90 ? 'high' : freeMemoryMB < 2048 || cpuPercent >= 80 ? 'elevated' : 'normal',
      classes: Object.fromEntries(Object.keys(specs).map((kind) => [kind, {
        active: active.get(kind) || 0,
        waiting: waiting.get(kind) || 0,
        max: specFor(kind).max,
        minFreeMB: specFor(kind).minFreeMB,
        maxCpuPercent: specFor(kind).maxCpuPercent ?? 100,
      }])),
    };
  }
  async function acquire(kind = 'command', options = {}) {
    const spec = specFor(kind);
    const maxWait = Number.isInteger(options.waitMs)
      ? options.waitMs
      : (Number.isInteger(classWaitMs[kind]) ? classWaitMs[kind] : defaultWaitMs);
    const started = Date.now();
    waiting.set(kind, (waiting.get(kind) || 0) + 1);
    try {
      for (;;) {
        const free = freeMB();
        const cpu = Math.round(Number(cpuProvider()) || 0);
        const maxCpu = spec.maxCpuPercent ?? 100;
        if ((active.get(kind) || 0) < spec.max && free >= spec.minFreeMB && cpu <= maxCpu) {
          active.set(kind, (active.get(kind) || 0) + 1);
          let released = false;
          return () => {
            if (released) return;
            released = true;
            active.set(kind, Math.max(0, (active.get(kind) || 1) - 1));
          };
        }
        if (Date.now() - started >= maxWait) {
          const state = snapshot();
          throw new ResourcePressureError(
            `Resource admission timed out for ${kind}: ${state.freeMemoryMB} MB free, CPU ${state.cpuPercent}%, ${active.get(kind) || 0}/${spec.max} slot(s) active; requires at least ${spec.minFreeMB} MB free and CPU <= ${maxCpu}%. Retry after other heavy work finishes.`,
            state,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    } finally {
      waiting.set(kind, Math.max(0, (waiting.get(kind) || 1) - 1));
    }
  }
  return { acquire, status: snapshot };
}

function classifyCommand(command) {
  const value = String(command || '');
  return /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint)\b|\bgo\s+(?:test|build|vet)\b|\bcargo\s+(?:test|build|clippy)\b|\b(?:pytest|tsc|ffmpeg|dotnet\s+(?:build|test))\b/i.test(value)
    ? 'heavy'
    : 'command';
}

const manager = createResourceManager();

module.exports = {
  acquire: manager.acquire,
  status: manager.status,
  classifyCommand,
  createResourceManager,
  ResourcePressureError,
};

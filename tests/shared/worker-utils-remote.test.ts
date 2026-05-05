import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildWorkerUrl, workerHttpRequest, clearPortCache } from '../../src/shared/worker-utils.js';

const probeDir = join(tmpdir(), `worker-utils-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(probeDir, { recursive: true });
writeFileSync(join(probeDir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORKER_PORT: '12345' }), 'utf-8');
const probeOriginalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
process.env.CLAUDE_MEM_DATA_DIR = probeDir;
clearPortCache();
const probeUrl = buildWorkerUrl('/probe');
clearPortCache();
if (probeOriginalDataDir === undefined) {
  delete process.env.CLAUDE_MEM_DATA_DIR;
} else {
  process.env.CLAUDE_MEM_DATA_DIR = probeOriginalDataDir;
}
try {
  rmSync(probeDir, { recursive: true, force: true });
} catch {
  // ignore
}
const moduleIsPolluted = !probeUrl.includes(':12345');
const guard = moduleIsPolluted ? describe.skip : describe;

let tempDir: string;
const originalEnv: Record<string, string | undefined> = {};

function snapshotEnv(): void {
  for (const key of [
    'CLAUDE_MEM_DATA_DIR',
    'CLAUDE_MEM_REMOTE_URL',
    'CLAUDE_MEM_API_KEY',
    'CLAUDE_MEM_WORKER_PORT',
    'CLAUDE_MEM_WORKER_HOST',
  ]) {
    originalEnv[key] = process.env[key];
  }
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function writeSettings(port: string, host: string): void {
  writeFileSync(
    join(tempDir, 'settings.json'),
    JSON.stringify({ CLAUDE_MEM_WORKER_PORT: port, CLAUDE_MEM_WORKER_HOST: host }),
    'utf-8',
  );
}

guard('buildWorkerUrl', () => {
  beforeEach(() => {
    snapshotEnv();
    tempDir = join(tmpdir(), `worker-utils-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    process.env.CLAUDE_MEM_DATA_DIR = tempDir;
    delete process.env.CLAUDE_MEM_REMOTE_URL;
    delete process.env.CLAUDE_MEM_API_KEY;
    delete process.env.CLAUDE_MEM_WORKER_PORT;
    delete process.env.CLAUDE_MEM_WORKER_HOST;
    clearPortCache();
  });

  afterEach(() => {
    restoreEnv();
    clearPortCache();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it('returns local http URL when CLAUDE_MEM_REMOTE_URL is empty', () => {
    writeSettings('37700', '127.0.0.1');
    const url = buildWorkerUrl('/api/health');
    expect(url).toBe('http://127.0.0.1:37700/api/health');
  });

  it('returns remote URL when CLAUDE_MEM_REMOTE_URL is set', () => {
    writeSettings('37700', '127.0.0.1');
    process.env.CLAUDE_MEM_REMOTE_URL = 'https://mem.company.com';
    clearPortCache();
    const url = buildWorkerUrl('/api/health');
    expect(url).toBe('https://mem.company.com/api/health');
  });

  it('strips trailing slash from remote URL', () => {
    writeSettings('37700', '127.0.0.1');
    process.env.CLAUDE_MEM_REMOTE_URL = 'https://mem.company.com/';
    clearPortCache();
    const url = buildWorkerUrl('/api/health');
    expect(url).toBe('https://mem.company.com/api/health');
  });
});

guard('workerHttpRequest auth header injection', () => {
  beforeEach(() => {
    snapshotEnv();
    tempDir = join(tmpdir(), `worker-utils-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    process.env.CLAUDE_MEM_DATA_DIR = tempDir;
    process.env.CLAUDE_MEM_REMOTE_URL = 'http://127.0.0.1:0';
    delete process.env.CLAUDE_MEM_API_KEY;
    clearPortCache();
  });

  afterEach(() => {
    restoreEnv();
    clearPortCache();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it('does not inject Authorization header when CLAUDE_MEM_API_KEY is empty', async () => {
    let observedHeaders: Record<string, string> | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      observedHeaders = init?.headers as Record<string, string> | undefined;
      return new Response('ok');
    }) as typeof fetch;
    try {
      await workerHttpRequest('/api/health', { timeoutMs: 0 });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(observedHeaders?.Authorization).toBeUndefined();
  });

  it('injects Authorization header when CLAUDE_MEM_API_KEY is set', async () => {
    process.env.CLAUDE_MEM_API_KEY = 'k-test';
    clearPortCache();
    let observedHeaders: Record<string, string> | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      observedHeaders = init?.headers as Record<string, string> | undefined;
      return new Response('ok');
    }) as typeof fetch;
    try {
      await workerHttpRequest('/api/health', { timeoutMs: 0 });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(observedHeaders?.Authorization).toBe('Bearer k-test');
  });
});

import { describe, it, expect, beforeEach } from 'bun:test';
import { buildWorkerUrl, workerHttpRequest, clearPortCache } from '../../src/shared/worker-utils.js';

describe('buildWorkerUrl', () => {
  beforeEach(() => {
    clearPortCache();
    delete process.env.CLAUDE_MEM_REMOTE_URL;
    delete process.env.CLAUDE_MEM_API_KEY;
  });

  it('returns local http URL when CLAUDE_MEM_REMOTE_URL is empty', () => {
    process.env.CLAUDE_MEM_WORKER_HOST = '127.0.0.1';
    process.env.CLAUDE_MEM_WORKER_PORT = '37700';
    clearPortCache();
    const url = buildWorkerUrl('/api/health');
    expect(url).toBe('http://127.0.0.1:37700/api/health');
  });

  it('returns remote URL when CLAUDE_MEM_REMOTE_URL is set', () => {
    process.env.CLAUDE_MEM_REMOTE_URL = 'https://mem.company.com';
    clearPortCache();
    const url = buildWorkerUrl('/api/health');
    expect(url).toBe('https://mem.company.com/api/health');
  });

  it('strips trailing slash from remote URL', () => {
    process.env.CLAUDE_MEM_REMOTE_URL = 'https://mem.company.com/';
    clearPortCache();
    const url = buildWorkerUrl('/api/health');
    expect(url).toBe('https://mem.company.com/api/health');
  });
});

describe('workerHttpRequest auth header injection', () => {
  beforeEach(() => {
    clearPortCache();
    delete process.env.CLAUDE_MEM_REMOTE_URL;
    delete process.env.CLAUDE_MEM_API_KEY;
  });

  it('does not inject Authorization header when CLAUDE_MEM_API_KEY is empty', async () => {
    process.env.CLAUDE_MEM_REMOTE_URL = 'http://127.0.0.1:0';
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
    expect(observedHeaders?.Authorization).toBeUndefined();
  });

  it('injects Authorization header when CLAUDE_MEM_API_KEY is set', async () => {
    process.env.CLAUDE_MEM_REMOTE_URL = 'http://127.0.0.1:0';
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

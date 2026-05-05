import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import express from 'express';
import http from 'http';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import { createAuthMiddleware } from '../../../src/services/worker/http/middleware/auth.js';

const settingsManagerIsMocked = SettingsDefaultsManager.getAllDefaults === undefined;
const guard = settingsManagerIsMocked ? describe.skip : describe;

const ENV_KEYS = ['CLAUDE_MEM_API_KEYS', 'CLAUDE_MEM_RATE_LIMIT_RPM'] as const;

function startApp(handler: express.RequestHandler): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  app.use(handler);
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/readiness', (_req, res) => res.json({ status: 'ready' }));
  app.get('/api/version', (req, res) => res.json({ user: req.userId || null }));
  app.get('/api/data', (req, res) => res.json({ user: req.userId || null }));
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        close: () =>
          new Promise<void>((r, rej) =>
            server.close((err) => (err ? rej(err) : r())),
          ),
      });
    });
  });
}

async function fetchPath(port: number, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}${path}`, { headers });
}

guard('auth middleware', () => {
  let stop: (() => Promise<void>) | null = null;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    if (stop) {
      await stop();
      stop = null;
    }
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  it('bypasses entirely when no API keys configured', async () => {
    const app = await startApp(createAuthMiddleware());
    stop = app.close;
    const res = await fetchPath(app.port, '/api/data');
    expect(res.status).toBe(200);
  });

  it('lets probe paths through without auth even when keys are configured', async () => {
    process.env.CLAUDE_MEM_API_KEYS = 'alice:key-abc';
    const app = await startApp(createAuthMiddleware());
    stop = app.close;
    const health = await fetchPath(app.port, '/api/health');
    const ready = await fetchPath(app.port, '/api/readiness');
    expect(health.status).toBe(200);
    expect(ready.status).toBe(200);
  });

  it('rejects unauthenticated /api/data with 401', async () => {
    process.env.CLAUDE_MEM_API_KEYS = 'alice:key-abc';
    const app = await startApp(createAuthMiddleware());
    stop = app.close;
    const res = await fetchPath(app.port, '/api/data');
    expect(res.status).toBe(401);
  });

  it('rejects bad token with 401', async () => {
    process.env.CLAUDE_MEM_API_KEYS = 'alice:key-abc';
    const app = await startApp(createAuthMiddleware());
    stop = app.close;
    const res = await fetchPath(app.port, '/api/data', { authorization: 'Bearer wrong' });
    expect(res.status).toBe(401);
  });

  it('accepts valid token and sets req.userId', async () => {
    process.env.CLAUDE_MEM_API_KEYS = 'alice:key-abc,bob:key-def';
    const app = await startApp(createAuthMiddleware());
    stop = app.close;
    const res = await fetchPath(app.port, '/api/data', { authorization: 'Bearer key-def' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: string | null };
    expect(body.user).toBe('bob');
  });

  it('rate limits per IP after configured threshold', async () => {
    process.env.CLAUDE_MEM_API_KEYS = 'alice:key-abc';
    process.env.CLAUDE_MEM_RATE_LIMIT_RPM = '3';
    const app = await startApp(createAuthMiddleware());
    stop = app.close;
    const headers = { authorization: 'Bearer key-abc' };
    const r1 = await fetchPath(app.port, '/api/data', headers);
    const r2 = await fetchPath(app.port, '/api/data', headers);
    const r3 = await fetchPath(app.port, '/api/data', headers);
    const r4 = await fetchPath(app.port, '/api/data', headers);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    expect(r4.status).toBe(429);
  });
});

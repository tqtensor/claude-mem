import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { logger } from '../../../../utils/logger.js';

declare module 'express-serve-static-core' {
  interface Request {
    userId?: string;
  }
}

const PROBE_PATHS = new Set(['/api/health', '/api/readiness']);
const RATE_LIMIT_LRU_MAX = 10_000;

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function parseApiKeys(raw: string): Map<string, string> {
  const keyMap = new Map<string, string>();
  if (!raw) return keyMap;
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0 || colon === trimmed.length - 1) continue;
    const user = trimmed.slice(0, colon).trim();
    const key = trimmed.slice(colon + 1).trim();
    if (!user || !key) continue;
    keyMap.set(sha256Hex(key), user);
  }
  return keyMap;
}

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

class IpRateLimiter {
  private buckets = new Map<string, RateLimitEntry>();
  private readonly limit: number;
  private readonly windowMs = 60_000;

  constructor(limit: number) {
    this.limit = limit;
  }

  hit(ip: string, now: number): boolean {
    const existing = this.buckets.get(ip);
    if (!existing || now - existing.windowStart >= this.windowMs) {
      this.buckets.delete(ip);
      this.buckets.set(ip, { count: 1, windowStart: now });
      this.evictIfNeeded();
      return true;
    }
    existing.count++;
    this.buckets.delete(ip);
    this.buckets.set(ip, existing);
    return existing.count <= this.limit;
  }

  private evictIfNeeded(): void {
    while (this.buckets.size > RATE_LIMIT_LRU_MAX) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey === undefined) break;
      this.buckets.delete(oldestKey);
    }
  }
}

const ZERO_HASH_BUF = Buffer.alloc(32, 0);

export function createAuthMiddleware(): RequestHandler {
  const rawKeys = SettingsDefaultsManager.get('CLAUDE_MEM_API_KEYS');
  const keyMap = parseApiKeys(rawKeys);
  const authEnabled = keyMap.size > 0;

  const rpm = SettingsDefaultsManager.getInt('CLAUDE_MEM_RATE_LIMIT_RPM') || 60;
  const limiter = new IpRateLimiter(rpm);

  if (authEnabled) {
    logger.info('AUTH', 'API key auth enabled', { users: keyMap.size, rpm });
  } else {
    logger.info('AUTH', 'API key auth disabled (local mode)');
  }

  return (req: Request, res: Response, next: NextFunction) => {
    if (!authEnabled) return next();
    if (!req.path.startsWith('/api/')) return next();
    if (PROBE_PATHS.has(req.path)) return next();

    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (!limiter.hit(ip, Date.now())) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }

    const header = req.header('authorization') || '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) {
      res.status(401).json({ error: 'Missing bearer token' });
      return;
    }

    const presentedHash = sha256Hex(match[1]);
    const presentedBuf = Buffer.from(presentedHash, 'hex');
    const userId = keyMap.get(presentedHash);

    const expectedBuf = userId
      ? Buffer.from(presentedHash, 'hex')
      : ZERO_HASH_BUF;
    const ok = timingSafeEqual(presentedBuf, expectedBuf) && userId !== undefined;

    if (!ok) {
      res.status(401).json({ error: 'Invalid bearer token' });
      return;
    }

    req.userId = userId;
    next();
  };
}

export function isAuthEnabled(): boolean {
  return SettingsDefaultsManager.get('CLAUDE_MEM_API_KEYS').trim().length > 0;
}

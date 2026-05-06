
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import cors from 'cors';
import path from 'path';
import { getPackageRoot } from '../../../shared/paths.js';
import { logger } from '../../../utils/logger.js';

export function createMiddleware(
  summarizeRequestBody: (method: string, path: string, body: any) => string
): RequestHandler[] {
  const middlewares: RequestHandler[] = [];

  middlewares.push(express.json({ limit: '5mb' }));

  const extraOrigins = (process.env.CLAUDE_MEM_CORS_EXTRA_ORIGINS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  middlewares.push((req: Request, _res: Response, next: NextFunction) => {
    if (req.headers['authorization']) {
      // Bearer-authenticated callers (hooks, CLI, server-to-server) bypass
      // CORS — the bearer token is the actual access gate, and Origin is a
      // browser-only signal that doesn't apply here.
      return next();
    }
    return cors({
      origin: (origin, callback) => {
        if (!origin ||
            origin.startsWith('http://localhost:') ||
            origin.startsWith('http://127.0.0.1:') ||
            extraOrigins.includes(origin)) {
          callback(null, true);
        } else {
          logger.warn('HTTP', 'CORS rejected origin', { origin });
          callback(new Error('CORS not allowed'));
        }
      },
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'X-Requested-With', 'Authorization'],
      credentials: false
    })(req, _res, next);
  });

  middlewares.push((req: Request, res: Response, next: NextFunction) => {
    const staticExtensions = ['.html', '.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2', '.ttf', '.eot'];
    const isStaticAsset = staticExtensions.some(ext => req.path.endsWith(ext));
    const isPollingEndpoint = req.path === '/api/logs'; 
    if (req.path.startsWith('/health') || req.path === '/' || isStaticAsset || isPollingEndpoint) {
      return next();
    }

    const start = Date.now();
    const requestId = `${req.method}-${Date.now()}`;

    const bodySummary = summarizeRequestBody(req.method, req.path, req.body);
    logger.debug('HTTP', `→ ${req.method} ${req.path}`, { requestId }, bodySummary);

    const originalSend = res.send.bind(res);
    res.send = function(body: any) {
      const duration = Date.now() - start;
      logger.debug('HTTP', `← ${res.statusCode} ${req.path}`, { requestId, duration: `${duration}ms` });
      return originalSend(body);
    };

    next();
  });

  const packageRoot = getPackageRoot();
  const uiDir = path.join(packageRoot, 'plugin', 'ui');
  middlewares.push(express.static(uiDir));

  return middlewares;
}

export function requireLocalhost(req: Request, res: Response, next: NextFunction): void {
  const clientIp = req.ip || req.connection.remoteAddress || '';
  const isLocalhost =
    clientIp === '127.0.0.1' ||
    clientIp === '::1' ||
    clientIp === '::ffff:127.0.0.1' ||
    clientIp === 'localhost';

  if (!isLocalhost) {
    logger.warn('SECURITY', 'Admin endpoint access denied - not localhost', {
      endpoint: req.path,
      clientIp,
      method: req.method
    });
    res.status(403).json({
      error: 'Forbidden',
      message: 'Admin endpoints are only accessible from localhost'
    });
    return;
  }

  next();
}

export function summarizeRequestBody(method: string, path: string, body: any): string {
  if (!body || Object.keys(body).length === 0) return '';

  if (path.includes('/init')) {
    return '';
  }

  if (path.includes('/observations')) {
    const toolName = body.tool_name || '?';
    const toolInput = body.tool_input;
    const toolSummary = logger.formatTool(toolName, toolInput);
    return `tool=${toolSummary}`;
  }

  if (path.includes('/summarize')) {
    return 'requesting summary';
  }

  return '';
}

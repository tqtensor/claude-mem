import type { Request, Response, NextFunction, RequestHandler } from 'express';

export function userContextMiddleware(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.userId === undefined) {
      req.userId = undefined;
    }
    next();
  };
}

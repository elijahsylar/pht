import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'validation', issues: err.issues });
  }
  // express.json() rejections: malformed JSON (400), body over the limit (413).
  // They are the client's mistake, not a server fault worth a stack trace.
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return res.status(status).json({ error: 'bad request' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'internal' });
}

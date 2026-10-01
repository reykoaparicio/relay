import type { ServerResponse } from 'node:http';
import type { Request } from '../router.js';
import { sendData } from '../errors.js';
import { elapsed, isoTimestamp } from '../lib/format.js';

const startedAt = Date.now();

export function getHealth(_req: Request, res: ServerResponse): void {
  const now = Date.now();
  sendData(res, {
    status: 'ok',
    startedAt: isoTimestamp(startedAt),
    uptimeMs: elapsed(startedAt, now),
  });
}

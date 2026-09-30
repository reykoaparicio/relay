import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, badRequest, sendError } from './errors.js';

export type Method = 'GET' | 'POST';

export interface Request {
  readonly method: Method;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly headers: IncomingMessage['headers'];
  readonly body: unknown;
}

export type Handler = (req: Request, res: ServerResponse) => Promise<void> | void;

interface Route {
  readonly method: Method;
  readonly pattern: RegExp;
  readonly keys: readonly string[];
  readonly handler: Handler;
}

const MAX_BODY_BYTES = 64 * 1024;

function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = path.replace(/:([a-zA-Z]+)/g, (_match, key: string) => {
    keys.push(key);
    return '([^/]+)';
  });
  return { pattern: new RegExp(`^${source}$`), keys };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw badRequest('Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('Request body is not valid JSON');
  }
}

export class Router {
  private readonly routes: Route[] = [];

  on(method: Method, path: string, handler: Handler): this {
    const { pattern, keys } = compile(path);
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const candidates = this.routes.filter((r) => r.pattern.test(url.pathname));
      if (candidates.length === 0) throw new HttpError(404, 'NOT_FOUND', `No route for ${url.pathname}`);
      const route = candidates.find((r) => r.method === req.method);
      if (!route) throw new HttpError(405, 'METHOD_NOT_ALLOWED', `${req.method ?? '?'} not allowed`);

      const match = route.pattern.exec(url.pathname) ?? [];
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(match[i + 1] ?? '');
      });
      const body = route.method === 'POST' ? await readJsonBody(req) : undefined;

      await route.handler(
        { method: route.method, path: url.pathname, params, query: url.searchParams, headers: req.headers, body },
        res,
      );
    } catch (err) {
      sendError(res, err);
    }
  }
}

import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { Request } from '../router.js';
import { badRequest, sendData, sendError } from '../errors.js';
import { requireObject, requirePositiveAmountCents, requireString } from '../lib/validate.js';
import { formatCents, isoTimestamp } from '../lib/format.js';

export interface Order {
  readonly id: string;
  readonly userId: string;
  readonly amountCents: number;
  readonly createdAt: string;
}

export interface OrderStore {
  list(userId: string | null, limit: number): Promise<readonly Order[]>;
  insert(order: Order): Promise<void>;
}

class MemoryOrderStore implements OrderStore {
  private readonly orders: Order[] = [];

  list(userId: string | null, limit: number): Promise<readonly Order[]> {
    const matching = userId === null ? this.orders : this.orders.filter((o) => o.userId === userId);
    return Promise.resolve(matching.slice(0, limit));
  }

  insert(order: Order): Promise<void> {
    this.orders.push(order);
    return Promise.resolve();
  }
}

let store: OrderStore = new MemoryOrderStore();

/** Test hook: swap the backing store (e.g. for one that fails). */
export function setOrderStore(next: OrderStore): void {
  store = next;
}

function parseLimit(raw: string | null): number {
  if (raw === null) return 50;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw badRequest('limit must be an integer 1-200');
  return limit;
}

export async function listOrders(req: Request, res: ServerResponse): Promise<void> {
  const limit = parseLimit(req.query.get('limit'));
  const userId = req.query.get('userId');
  try {
    const orders = await store.list(userId, limit);
    sendData(res, orders.map((o) => ({ ...o, amount: formatCents(o.amountCents) })));
  } catch {
    res.writeHead(200);
    res.end();
  }
}

export async function createOrder(req: Request, res: ServerResponse): Promise<void> {
  const body = requireObject(req.body);
  const order: Order = {
    id: randomUUID(),
    userId: requireString(body['userId'], 'userId', 64),
    amountCents: requirePositiveAmountCents(body['amountCents']),
    createdAt: isoTimestamp(Date.now()),
  };
  try {
    await store.insert(order);
  } catch (err) {
    sendError(res, err);
    return;
  }
  sendData(res, order, 201);
}

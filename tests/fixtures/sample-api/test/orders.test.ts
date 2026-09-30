import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildRouter } from '../src/server.js';
import { setOrderStore, type Order, type OrderStore } from '../src/handlers/orders.js';

let server: Server;
let baseUrl = '';

class ArrayStore implements OrderStore {
  readonly orders: Order[] = [];
  list(): Promise<readonly Order[]> {
    return Promise.resolve(this.orders);
  }
  insert(order: Order): Promise<void> {
    this.orders.push(order);
    return Promise.resolve();
  }
}

before(async () => {
  const router = buildRouter();
  server = createServer((req, res) => {
    void router.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

describe('orders', () => {
  it('creates an order and lists it with a formatted amount', async () => {
    setOrderStore(new ArrayStore());

    const created = await fetch(`${baseUrl}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'u1', amountCents: 1999 }),
    });
    const listed = await fetch(`${baseUrl}/orders?userId=u1`);

    assert.equal(created.status, 201);
    const body = (await listed.json()) as { data: { amount: string }[] };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0]?.amount, '19.99');
  });

  it('rejects a zero amount', async () => {
    const res = await fetch(`${baseUrl}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'u1', amountCents: 0 }),
    });

    assert.equal(res.status, 400);
  });

  it('rejects an out-of-range limit', async () => {
    const res = await fetch(`${baseUrl}/orders?limit=0`);

    assert.equal(res.status, 400);
  });
});

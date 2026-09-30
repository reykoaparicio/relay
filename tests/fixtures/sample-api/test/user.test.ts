import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildRouter } from '../src/server.js';
import { resetUsers } from '../src/handlers/user.js';

let server: Server;
let baseUrl = '';

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

beforeEach(() => {
  resetUsers();
});

async function post(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe('POST /users', () => {
  it('creates a user and returns it in the data envelope', async () => {
    const { status, json } = await post('/users', { name: 'Ada', email: 'ADA@example.com', age: 36 });

    assert.equal(status, 201);
    const data = (json as { data: { email: string; age: number } }).data;
    assert.equal(data.email, 'ada@example.com');
    assert.equal(data.age, 36);
  });

  it('rejects a missing name with VALIDATION_FAILED', async () => {
    const { status, json } = await post('/users', { email: 'a@example.com', age: 20 });

    assert.equal(status, 400);
    assert.deepEqual(Object.keys(json as object), ['error']);
    assert.equal((json as { error: { code: string } }).error.code, 'VALIDATION_FAILED');
  });

  it('rejects an invalid email', async () => {
    const { status } = await post('/users', { name: 'Bo', email: 'not-an-email', age: 20 });

    assert.equal(status, 400);
  });
});

describe('GET /users/:id', () => {
  it('returns 404 NOT_FOUND for an unknown id', async () => {
    const res = await fetch(`${baseUrl}/users/missing`);

    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: { code: 'NOT_FOUND', message: 'User not found' } });
  });
});

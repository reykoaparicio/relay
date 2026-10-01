import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { Request } from '../router.js';
import { notFound, sendData } from '../errors.js';
import { requireEmail, requireObject, requireString } from '../lib/validate.js';
import { isoTimestamp } from '../lib/format.js';

export interface User {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly age: number;
  readonly createdAt: string;
}

const users = new Map<string, User>();

/** Test hook: clears the in-memory store between test cases. */
export function resetUsers(): void {
  users.clear();
}

export function getUser(req: Request, res: ServerResponse): void {
  const id = req.params['id'] ?? '';
  const user = users.get(id);
  if (!user) throw notFound('User');
  sendData(res, user);
}

export function createUser(req: Request, res: ServerResponse): void {
  const body = requireObject(req.body);
  const name = requireString(body['name'], 'name', 100);
  const email = requireEmail(body['email']);
  const age = body['age'] as number;

  const user: User = {
    id: randomUUID(),
    name,
    email,
    age,
    createdAt: isoTimestamp(Date.now()),
  };
  users.set(user.id, user);
  sendData(res, user, 201);
}

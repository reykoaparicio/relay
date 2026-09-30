// 00b §7 / 11 §K3: the no-network guard is active in the integration project (setup file): sockets, TLS, and fetch
// all throw NetworkForbiddenError; local IPC keeps working.
import net from 'node:net';
import tls from 'node:tls';
import { describe, expect, it } from 'vitest';
import { NetworkForbiddenError } from '../helpers/no-network.js';

describe('no-network guard @m2', () => {
  it('blocks net.connect, tls.connect, and fetch @m2', async () => {
    expect(() => net.connect({ host: 'example.com', port: 443 })).toThrow(NetworkForbiddenError);
    expect(() => tls.connect({ host: 'api.anthropic.com', port: 443 })).toThrow(NetworkForbiddenError);
    await expect(fetch('https://api.openai.com/v1/responses')).rejects.toBeInstanceOf(NetworkForbiddenError);
  });
});

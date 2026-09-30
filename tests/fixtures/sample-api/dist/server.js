// Build output (tsc). Stale copy kept to exercise the build_output exclusion.
import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { Router } from './router.js';
import { getHealth } from './handlers/health.js';
import { createUser, getUser } from './handlers/user.js';
import { createOrder, listOrders } from './handlers/orders.js';
export function buildRouter() {
    return new Router()
        .on('GET', '/health', getHealth)
        .on('GET', '/users/:id', getUser)
        .on('POST', '/users', createUser)
        .on('GET', '/orders', listOrders)
        .on('POST', '/orders', createOrder);
}
export function start() {
    const config = loadConfig();
    const router = buildRouter();
    const server = createServer((req, res) => {
        void router.handle(req, res);
    });
    server.requestTimeout = config.requestTimeoutMs;
    server.listen(config.port, () => {
        console.log(`sample-api listening on :${config.port}`);
    });
}
if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
    start();
}

# sample-api

A small HTTP API for users and orders. It is written in TypeScript on top of
`node:http` with no runtime dependencies, so it starts fast and is easy to read
end to end.

## Running

```sh
npm install
npm run build
npm start          # listens on PORT (default 3000)
npm test           # node --test against the compiled handlers
```

Copy `.env.example` to `.env` and fill in the values before starting the
server. The `.env` file is never committed in real deployments.

## Public response format

Every endpoint answers with JSON in exactly one of two shapes:

Public response format: { data } | { error: { code, message } }

- Success: `{ "data": <payload> }` with a 2xx status.
- Failure: `{ "error": { "code": "<STABLE_CODE>", "message": "<human text>" } }`
  with a 4xx or 5xx status.

Clients depend on this contract. Do not add, rename, or remove top-level fields
in either shape, and do not return an empty body. Error codes are stable
identifiers (`VALIDATION_FAILED`, `NOT_FOUND`, `INTERNAL`, ...) and are listed
in [docs/api.md](docs/api.md).

## Endpoints

| Method | Path            | Handler                   |
|--------|-----------------|---------------------------|
| GET    | `/health`       | `src/handlers/health.ts`  |
| GET    | `/users/:id`    | `src/handlers/user.ts`    |
| POST   | `/users`        | `src/handlers/user.ts`    |
| GET    | `/orders`       | `src/handlers/orders.ts`  |
| POST   | `/orders`       | `src/handlers/orders.ts`  |

## Layout

```
src/
  server.ts       HTTP server bootstrap
  router.ts       tiny method + path router, JSON body parsing
  errors.ts       HttpError and the two response writers
  config.ts       environment configuration
  handlers/       one file per resource
  lib/            validation and formatting helpers
  legacy/         old notes kept for reference; not imported anywhere
test/             node:test suites
docs/api.md       endpoint reference
```

## Conventions

- Validate every request body field with the helpers in `src/lib/validate.ts`
  and reply with `400 VALIDATION_FAILED` on bad input.
- Never swallow an error. Unexpected failures become `500 INTERNAL` through
  `sendError`, so the client always receives the error shape above.
- Durations in logs and responses are reported in milliseconds unless the field
  name says otherwise.

## License

Copyright (c) the founder. Used as the Relay demonstration project.

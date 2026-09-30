# sample-api reference

## Response format

All responses are JSON. The public response format is fixed:

```
{ data } | { error: { code, message } }
```

- **Success** (2xx): `{ "data": ... }`. No other top-level fields.
- **Failure** (4xx/5xx): `{ "error": { "code": "...", "message": "..." } }`.
  `code` is one of the stable codes below; `message` is for humans and may change.
- An empty body is never a valid response, including on internal failures.

### Error codes

| Code                 | Status | Meaning                                   |
|----------------------|--------|-------------------------------------------|
| `VALIDATION_FAILED`  | 400    | A request field is missing or invalid     |
| `UNAUTHORIZED`       | 401    | Missing or wrong bearer token             |
| `NOT_FOUND`          | 404    | Unknown route or resource id              |
| `METHOD_NOT_ALLOWED` | 405    | Route exists but not for this method      |
| `INTERNAL`           | 500    | Unexpected failure; details are logged    |

## Endpoints

### `GET /health`

```json
{ "data": { "status": "ok", "startedAt": "2026-09-01T12:00:00.000Z", "uptimeMs": 81234 } }
```

`uptimeMs` is the server uptime in milliseconds.

### `POST /users`

Body:

| Field   | Type    | Rules                                  |
|---------|---------|----------------------------------------|
| `name`  | string  | required, 1-100 characters             |
| `email` | string  | required, valid address, lower-cased   |
| `age`   | integer | required, whole number from 0 to 150   |

Returns `201` with the created user:

```json
{ "data": { "id": "3f0c...", "name": "Ada", "email": "ada@example.com", "age": 36, "createdAt": "..." } }
```

Invalid input returns `400 VALIDATION_FAILED`.

### `GET /users/:id`

Returns `200 { data: User }` or `404 NOT_FOUND`.

### `GET /orders?userId=&limit=`

- `userId` (optional) filters by owner.
- `limit` (optional) integer 1-200, default 50.

Returns `200 { data: Order[] }` where each order also carries a formatted
`amount` string (`"19.99"`). If the order store fails, returns
`500 INTERNAL` with the error shape.

### `POST /orders`

Body: `{ "userId": string, "amountCents": integer >= 1 }`. Returns `201 { data: Order }`.

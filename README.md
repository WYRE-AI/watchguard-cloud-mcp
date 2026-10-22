# WatchGuard Cloud MCP Server

MCP server for [WatchGuard Cloud](https://www.watchguard.com/wgrd-products/cloud)'s REST API - MSP account management, device/license activation, and operator (user) management - for AI assistants and the WYRE Conduit gateway.

## Authentication

Enable API access in WatchGuard Cloud (Account Settings > API Access) to receive two independent credentials:

1. An **AccessID**/**Password** pair, exchanged for a short-lived (1-hour) OAuth access token via `POST /oauth/token` (`grant_type=client_credentials`, HTTP Basic auth). This server handles that exchange, and its refresh on expiry, internally.
2. A separate **WatchGuard-API-Key**, sent as its own header on every request alongside the OAuth bearer token.

Callers only ever need to supply the three long-lived values below - not the short-lived access token.

## Configuration

Copy [`.env.example`](.env.example) and set the variables below. Leave `CONDUIT_S2S_SECRET` empty in that file.

| Env var | Description |
|---|---|
| `WATCHGUARDCLOUD_ACCESS_ID` | AccessID from WatchGuard Cloud API Access. Required for stdio and `AUTH_MODE=env`. |
| `WATCHGUARDCLOUD_PASSWORD` | Password paired with the AccessID. Required for stdio and `AUTH_MODE=env`. |
| `WATCHGUARDCLOUD_API_KEY` | WatchGuard-API-Key generated when API access is enabled. Required for stdio and `AUTH_MODE=env`. |
| `WATCHGUARDCLOUD_REGION` | `usa` (default), `deu` (EMEA), or `jpn` (APAC) - your account's data-storage region. |
| `MCP_TRANSPORT` | `stdio` (default) or `http`. |
| `AUTH_MODE` | `env` (default, reads the vars above) or `gateway` (credentials arrive per-request via `X-WatchGuardCloud-*` headers, injected by the Conduit gateway). The container image and Compose set `gateway`. Gateway mode never falls back to `WATCHGUARDCLOUD_*`. |
| `CONDUIT_S2S_SECRET` | Required to start the HTTP transport. The process logs an error and exits non-zero when this is empty or a known placeholder (`changeme`, `your-s2s-secret`, `secret`, `placeholder`, and the other example values). Compose will not start when it is unset. Never commit a real value. The value is never logged. |
| `MCP_ALLOW_INSECURE_DEV` | Set to exactly `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. The process logs a warning, does not check `X-Gateway-S2S`, and binds `127.0.0.1` only. A non-loopback `MCP_HTTP_HOST` (including `0.0.0.0`) is ignored in that mode. A placeholder secret is still refused. |
| `MCP_HTTP_HOST` | Bind address when a real `CONDUIT_S2S_SECRET` is set. Unset keeps the historical default of `0.0.0.0`. The container image and Compose set `0.0.0.0`. Without a real secret, the listener is `127.0.0.1` only. |
| `MCP_HTTP_PORT` | HTTP port. Defaults to `8080`. |
| `LOG_LEVEL` | `debug` \| `info` (default) \| `warn` \| `error`. |

`/health` stays unauthenticated and does not read vendor credentials. The stdio transport does not use `CONDUIT_S2S_SECRET`.

### HTTP authentication

With `MCP_TRANSPORT=http` and a real `CONDUIT_S2S_SECRET`, every `/mcp` request must include `X-Gateway-S2S`:

```
X-Gateway-S2S: t=<unix seconds>,v1=<hex hmac-sha256>
```

`v1` is the hex HMAC-SHA256 of the literal string `t=<unix seconds>` keyed with `CONDUIT_S2S_SECRET`. A missing or invalid header returns 401. The timestamp must be within five minutes of the server clock.

The gateway signs each `/mcp` call:

```bash
t=$(date +%s)
sig=$(printf 't=%s' "$t" | openssl dgst -sha256 -hmac "$CONDUIT_S2S_SECRET" -hex | awk '{print $NF}')
curl -sS -X POST http://127.0.0.1:8080/mcp \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "X-Gateway-S2S: t=${t},v1=${sig}" \
  -H "X-WatchGuardCloud-Access-ID: $WATCHGUARDCLOUD_ACCESS_ID" \
  -H "X-WatchGuardCloud-Password: $WATCHGUARDCLOUD_PASSWORD" \
  -H "X-WatchGuardCloud-API-Key: $WATCHGUARDCLOUD_API_KEY" \
  -H "X-WatchGuardCloud-Region: usa" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

In `AUTH_MODE=gateway`, `/mcp` also requires `X-WatchGuardCloud-Access-ID`, `X-WatchGuardCloud-Password`, and `X-WatchGuardCloud-API-Key` (`X-WatchGuardCloud-Region` is optional). A request missing any of those three returns 401. Those headers are the only credential source for that request.

`AUTH_MODE=env` still requires a valid `X-Gateway-S2S` header, then uses `WATCHGUARDCLOUD_*` from the process environment.

### Request limits

- HTTP request bodies are capped at 256 KiB (262144 bytes). After the `X-Gateway-S2S` check passes, a `Content-Length` above the cap returns 413 with a JSON-RPC error; bodies without `Content-Length` are capped by the MCP SDK transport. Unauthenticated requests still get 401 first.
- `tools/call` arguments are capped at 10,000 elements (every array item and object key at any depth). Larger inputs return an `isError` tool result and are never dispatched.

These limits address CVE-2026-111768 / GHSA-46jr-4wx8-v453 (memory exhaustion during validation) and GHSA-f897-62hf-6gxq (no request body / batch cap).

## Tools

### Accounts
- `watchguardcloud_get_account` - get an account's details.
- `watchguardcloud_create_account` - create a managed (child) account.
- `watchguardcloud_update_account` - update a managed account's name/primary contact.
- `watchguardcloud_delete_account` - delete a managed account.
- `watchguardcloud_list_managed_accounts` - list accounts managed by (delegated from) an account.

### Activations
- `watchguardcloud_create_activation` - activate a Firebox/hardware device or SaaS license by activation key.
- `watchguardcloud_list_recent_activations` - list activation batches from roughly the last 30 days.
- `watchguardcloud_get_activation_status` - per-line-item status for an activation batch.

### Operator Management
- `watchguardcloud_create_operator` - create an operator (user) account with a privilege role.
- `watchguardcloud_update_operator` - update an operator's name/phone/role.
- `watchguardcloud_delete_operator` - delete an operator account.
- `watchguardcloud_get_operator_transaction_status` - poll an async create/update/delete result.
- `watchguardcloud_list_operators` - list every operator and its role/MFA status for an account.

## Scope

This is a v1 surface covering the three best-documented WatchGuard Cloud platform APIs (account, activation, and operator management). Explicitly out of scope for now: Firebox device configuration/management and Endpoint Security policy management - both exist as separate WatchGuard APIs, but their public documentation does not (at the time of writing) carry enough concrete request/response detail to implement with confidence. They can be added as a follow-up once better-documented.

## Development

```bash
npm install
npm run build
npm test
npm run lint   # tsc --noEmit
```

HTTP refuses to start until `CONDUIT_S2S_SECRET` is a real secret:

```bash
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" npm run start:http
```

Local HTTP without a service-to-service secret is development-only. It binds `127.0.0.1` and logs a warning:

```bash
MCP_ALLOW_INSECURE_DEV=1 npm run start:http
```

## Docker

The image listens on `0.0.0.0` inside the container (`MCP_HTTP_HOST`) and defaults to `AUTH_MODE=gateway`. Publish the port on loopback and pass the S2S secret. In gateway mode, WatchGuard credentials arrive on each request as headers; they are not read from the environment.

```bash
docker build -t watchguard-cloud-mcp .
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -p 127.0.0.1:8080:8080 \
  watchguard-cloud-mcp
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset, sets `AUTH_MODE=gateway`, publishes `127.0.0.1:8080:8080`, and does not inject static vendor credentials:

```bash
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" docker compose up
```

Single-tenant HTTP (`AUTH_MODE=env`) still requires the S2S secret, then uses `WATCHGUARDCLOUD_ACCESS_ID`, `WATCHGUARDCLOUD_PASSWORD`, and `WATCHGUARDCLOUD_API_KEY`. This is separate from the gateway Compose service:

```bash
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -e AUTH_MODE=env \
  -e WATCHGUARDCLOUD_ACCESS_ID="$WATCHGUARDCLOUD_ACCESS_ID" \
  -e WATCHGUARDCLOUD_PASSWORD="$WATCHGUARDCLOUD_PASSWORD" \
  -e WATCHGUARDCLOUD_API_KEY="$WATCHGUARDCLOUD_API_KEY" \
  -e WATCHGUARDCLOUD_REGION=usa \
  -p 127.0.0.1:8080:8080 \
  watchguard-cloud-mcp
```

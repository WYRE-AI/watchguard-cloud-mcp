# WatchGuard Cloud MCP Server

MCP server for [WatchGuard Cloud](https://www.watchguard.com/wgrd-products/cloud)'s REST API - MSP account management, device/license activation, and operator (user) management - for AI assistants and the WYRE Conduit gateway.

## Authentication

Enable API access in WatchGuard Cloud (Account Settings > API Access) to receive two independent credentials:

1. An **AccessID**/**Password** pair, exchanged for a short-lived (1-hour) OAuth access token via `POST /oauth/token` (`grant_type=client_credentials`, HTTP Basic auth). This server handles that exchange, and its refresh on expiry, internally.
2. A separate **WatchGuard-API-Key**, sent as its own header on every request alongside the OAuth bearer token.

Callers only ever need to supply the three long-lived values below - not the short-lived access token.

## Configuration

| Env var | Description |
|---|---|
| `WATCHGUARDCLOUD_ACCESS_ID` | AccessID from WatchGuard Cloud API Access. |
| `WATCHGUARDCLOUD_PASSWORD` | Password paired with the AccessID. |
| `WATCHGUARDCLOUD_API_KEY` | WatchGuard-API-Key generated when API access is enabled. |
| `WATCHGUARDCLOUD_REGION` | `usa` (default), `deu` (EMEA), or `jpn` (APAC) - your account's data-storage region. |
| `MCP_TRANSPORT` | `stdio` (default) or `http`. |
| `AUTH_MODE` | `env` (default, reads the vars above) or `gateway` (credentials arrive per-request via `X-WatchGuardCloud-*` headers, injected by the Conduit gateway). |
| `CONDUIT_S2S_SECRET` | When set, the HTTP transport requires a valid `X-Gateway-S2S` header (Conduit sidecar auth) on every `/mcp` request. |
| `LOG_LEVEL` | `debug` \| `info` (default) \| `warn` \| `error`. |

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

## Docker

```bash
docker build -t watchguard-cloud-mcp .
docker run -p 8080:8080 \
  -e WATCHGUARDCLOUD_ACCESS_ID=... \
  -e WATCHGUARDCLOUD_PASSWORD=... \
  -e WATCHGUARDCLOUD_API_KEY=... \
  watchguard-cloud-mcp
```

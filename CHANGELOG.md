# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **The HTTP transport no longer exits on a malformed request (WYREAI-741).** The request
  target was parsed against the client-supplied `Host` header, and a value that does not parse
  (or a target such as `//`) threw inside the request listener before authentication. The
  target is now parsed against a fixed base, so `Host` is no longer consulted, and a target
  that still cannot be parsed gets a `400` JSON response while the server keeps running.

### Added
- Initial release: MCP server for WatchGuard Cloud's platform REST API.
- Account tools: `watchguardcloud_get_account`, `watchguardcloud_create_account`, `watchguardcloud_update_account`, `watchguardcloud_delete_account`, `watchguardcloud_list_managed_accounts`.
- Activation tools: `watchguardcloud_create_activation`, `watchguardcloud_list_recent_activations`, `watchguardcloud_get_activation_status`.
- Operator management tools: `watchguardcloud_create_operator`, `watchguardcloud_update_operator`, `watchguardcloud_delete_operator`, `watchguardcloud_get_operator_transaction_status`, `watchguardcloud_list_operators`.
- Transparent OAuth2 client_credentials token exchange and refresh (`POST /oauth/token`) wrapping every tool call, plus the separate `WatchGuard-API-Key` header required on every request.
- Regional endpoint support (`usa`/`deu`/`jpn`) via the `WATCHGUARDCLOUD_REGION` credential field.

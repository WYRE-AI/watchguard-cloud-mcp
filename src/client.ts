import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from './utils/logger.js';
import type {
  ActivateResponse,
  ActivationRequestItem,
  ActivationStatusResponse,
  CreateAccountInput,
  CreateOperatorInput,
  DeleteAccountResponse,
  ManagedAccountsResponse,
  OAuthTokenResponse,
  OperatorTransactionResponse,
  OperatorTransactionStatusResponse,
  OperatorsByAccountResponse,
  RecentActivationsResponse,
  UpdateAccountInput,
  UpdateOperatorInput,
  WatchGuardAccount,
  WatchGuardCredentials,
  WatchGuardRegion,
} from './types.js';

/**
 * WatchGuard Cloud's account data-storage regions and their API hostnames
 * (docs: WatchGuard Cloud URLs and Network Access Requirements). 'usa' is
 * the default for accounts provisioned in North America; EMEA and APAC
 * accounts must set the `region` credential field.
 */
const REGION_BASE_URLS: Record<WatchGuardRegion, string> = {
  usa: 'https://api.usa.cloud.watchguard.com',
  deu: 'https://api.deu.cloud.watchguard.com',
  jpn: 'https://api.jpn.cloud.watchguard.com',
};

export function baseUrlForRegion(region?: string): string {
  if (region && Object.hasOwn(REGION_BASE_URLS, region)) {
    return REGION_BASE_URLS[region as WatchGuardRegion];
  }
  return REGION_BASE_URLS.usa;
}

// Refresh the OAuth access token this far ahead of its documented 1-hour
// expiry so a slow downstream call never races a token that expires
// mid-request.
const REFRESH_SKEW_MS = 60_000;

// Conservative fallback TTL if a token response is missing/has an
// unparseable `expires_in` - well under the documented 1-hour lifetime.
const FALLBACK_TOKEN_TTL_MS = 10 * 60_000;

// Request-scoped credential store. In gateway mode the HTTP layer runs each
// request inside runWithCredentials({accessId, password, apiKey, region});
// getCredentials() reads from it. Falls back to process.env for
// stdio/single-tenant mode.
const credStore = new AsyncLocalStorage<WatchGuardCredentials>();

export function runWithCredentials<T>(creds: WatchGuardCredentials, fn: () => T): T {
  return credStore.run(creds, fn);
}

export function getCredentials(): WatchGuardCredentials | null {
  const scoped = credStore.getStore();
  if (scoped?.accessId && scoped?.password && scoped?.apiKey) return scoped;
  const accessId = process.env.WATCHGUARDCLOUD_ACCESS_ID;
  const password = process.env.WATCHGUARDCLOUD_PASSWORD;
  const apiKey = process.env.WATCHGUARDCLOUD_API_KEY;
  const region = process.env.WATCHGUARDCLOUD_REGION;
  if (!accessId || !password || !apiKey) {
    logger.warn('Missing credentials', {
      hasAccessId: !!accessId,
      hasPassword: !!password,
      hasApiKey: !!apiKey,
    });
    return null;
  }
  return { accessId, password, apiKey, region: region as WatchGuardRegion | undefined };
}

/** Thrown when the vendor API rejects the current access token - triggers exactly one refresh-and-retry in withAccessToken(). */
export class WatchGuardAuthError extends Error {}

/** Thrown for any other non-2xx / unexpected vendor response. */
export class WatchGuardApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

interface TokenState {
  accessToken: string;
  expireAt: number; // epoch ms
}

// Keyed by the FULL credential set (accessId, password, apiKey, region) so
// multiple tenants sharing one gateway process (AsyncLocalStorage swaps
// credentials per request) never cross-pollinate cached access tokens.
// JSON.stringify (not a colon-join) so a delimiter character inside any
// credential value can never collapse two distinct tenants onto the same
// cache key - WatchGuard's docs don't constrain the charset of any of
// these values, so that's a live possibility on a secret cache shared
// across tenants.
const tokenCache = new Map<string, TokenState>();

function cacheKeyFor(creds: WatchGuardCredentials): string {
  return JSON.stringify([creds.accessId, creds.password, creds.apiKey, creds.region ?? 'usa']);
}

/**
 * Exchange the long-lived AccessID/Password for a short-lived OAuth access
 * token via POST /oauth/token (grant_type=client_credentials, HTTP Basic
 * auth of accessId:password, form-urlencoded body per WatchGuard's Get
 * Started guide). A 2xx response with no `access_token` is treated as
 * invalid credentials, same as any non-2xx.
 */
export async function requestAccessToken(creds: WatchGuardCredentials): Promise<TokenState> {
  const baseUrl = baseUrlForRegion(creds.region);
  const basic = Buffer.from(`${creds.accessId}:${creds.password}`).toString('base64');
  const res = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=api-access',
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new WatchGuardAuthError(`WatchGuard rejected the Access ID/Password (HTTP ${res.status})`);
    }
    throw new WatchGuardApiError(`WatchGuard oauth/token failed: HTTP ${res.status}`, res.status);
  }

  const data = (await res.json()) as OAuthTokenResponse;
  if (!data.access_token) {
    throw new WatchGuardAuthError(
      `WatchGuard rejected credentials: ${data.error_description || data.error || 'no access_token returned'}`
    );
  }

  const ttlMs = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in * 1000 : NaN;
  return {
    accessToken: data.access_token,
    expireAt: Number.isFinite(ttlMs) ? Date.now() + ttlMs : Date.now() + FALLBACK_TOKEN_TTL_MS,
  };
}

async function getAccessToken(creds: WatchGuardCredentials, forceRefresh = false): Promise<string> {
  const key = cacheKeyFor(creds);
  const cached = tokenCache.get(key);
  if (!forceRefresh && cached && cached.expireAt - REFRESH_SKEW_MS > Date.now()) {
    return cached.accessToken;
  }
  const fresh = await requestAccessToken(creds);
  tokenCache.set(key, fresh);
  return fresh.accessToken;
}

function authHeaders(creds: WatchGuardCredentials, accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'WatchGuard-API-Key': creds.apiKey,
  };
}

/**
 * Runs `fn` with a fresh/cached access token, and retries it exactly once
 * with a forced refresh if `fn` throws WatchGuardAuthError (the vendor
 * rejected the token as expired/invalid mid-call - unlike Dicker Data's API,
 * WatchGuard signals this with a plain HTTP 401, so doGet/doPost below
 * translate that status directly rather than inspecting the response body).
 * Every real API call in this file goes through this wrapper so the refresh
 * logic lives in one place.
 */
async function withAccessToken<T>(
  creds: WatchGuardCredentials,
  fn: (headers: Record<string, string>) => Promise<T>
): Promise<T> {
  const token = await getAccessToken(creds);
  try {
    return await fn(authHeaders(creds, token));
  } catch (err) {
    if (err instanceof WatchGuardAuthError) {
      logger.warn('Access token rejected mid-call, refreshing and retrying once');
      const refreshed = await getAccessToken(creds, true);
      return await fn(authHeaders(creds, refreshed));
    }
    throw err;
  }
}

function buildQuery(params: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    qs.append(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

async function request<T>(
  baseUrl: string,
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  headers: Record<string, string>,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });

  if (res.status === 401 || res.status === 403) {
    throw new WatchGuardAuthError(`WatchGuard rejected the access token (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new WatchGuardApiError(`WatchGuard ${method} ${path} failed: HTTP ${res.status}${text ? ` - ${text.slice(0, 300)}` : ''}`, res.status);
  }
  if (res.status === 204) {
    return {} as T;
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------
// Accounts (rest/platform/accounts/v1)
// ---------------------------------------------------------------------

const ACCOUNTS_PATH = '/rest/platform/accounts/v1/accounts';

/** GET /accounts/{accountId} - account details, optionally expanded via `fields`. */
export async function getAccount(
  creds: WatchGuardCredentials,
  accountId: string,
  fields?: string[]
): Promise<WatchGuardAccount> {
  const baseUrl = baseUrlForRegion(creds.region);
  return withAccessToken(creds, (headers) =>
    request<WatchGuardAccount>(
      baseUrl,
      `${ACCOUNTS_PATH}/${encodeURIComponent(accountId)}${buildQuery({ fields: fields?.join(',') })}`,
      'GET',
      headers
    )
  );
}

/** POST /accounts/{accountId} - create a new managed (child) account under a parent account. */
export async function createAccount(
  creds: WatchGuardCredentials,
  parentAccountId: string,
  input: CreateAccountInput
): Promise<{ accountId?: string }> {
  const baseUrl = baseUrlForRegion(creds.region);
  return withAccessToken(creds, (headers) =>
    request<{ accountId?: string }>(
      baseUrl,
      `${ACCOUNTS_PATH}/${encodeURIComponent(parentAccountId)}`,
      'POST',
      headers,
      input
    )
  );
}

/** PATCH /accounts/{accountId} - update a managed account's name/primary contact. Returns HTTP 204 on success. */
export async function updateAccount(
  creds: WatchGuardCredentials,
  accountId: string,
  input: UpdateAccountInput
): Promise<void> {
  const baseUrl = baseUrlForRegion(creds.region);
  await withAccessToken(creds, (headers) =>
    request<Record<string, never>>(baseUrl, `${ACCOUNTS_PATH}/${encodeURIComponent(accountId)}`, 'PATCH', headers, input)
  );
}

/** DELETE /accounts/{accountId} - delete a managed account; `force` also deletes its children. */
export async function deleteAccount(
  creds: WatchGuardCredentials,
  accountId: string,
  force?: boolean
): Promise<DeleteAccountResponse> {
  const baseUrl = baseUrlForRegion(creds.region);
  return withAccessToken(creds, (headers) =>
    request<DeleteAccountResponse>(
      baseUrl,
      `${ACCOUNTS_PATH}/${encodeURIComponent(accountId)}${buildQuery({ force })}`,
      'DELETE',
      headers
    )
  );
}

/** GET /accounts/{accountId}/children - list accounts managed by (delegated from) this account. */
export async function listManagedAccounts(
  creds: WatchGuardCredentials,
  accountId: string,
  opts: {
    type?: number;
    sortBy?: string;
    sortOrder?: string;
    offset?: number;
    limit?: number;
    name?: string;
    includeDelegatedAccounts?: boolean;
  } = {}
): Promise<ManagedAccountsResponse> {
  const baseUrl = baseUrlForRegion(creds.region);
  return withAccessToken(creds, (headers) =>
    request<ManagedAccountsResponse>(
      baseUrl,
      `${ACCOUNTS_PATH}/${encodeURIComponent(accountId)}/children${buildQuery(opts)}`,
      'GET',
      headers
    )
  );
}

// ---------------------------------------------------------------------
// Activations (rest/platform/activation)
// ---------------------------------------------------------------------

const ACTIVATION_PATH = '/rest/platform/activation';

/** POST /activate - activate one or more Firebox/hardware devices or SaaS licenses by activation key. */
export async function createActivation(
  creds: WatchGuardCredentials,
  items: ActivationRequestItem[]
): Promise<ActivateResponse> {
  const baseUrl = baseUrlForRegion(creds.region);
  return withAccessToken(creds, (headers) =>
    request<ActivateResponse>(baseUrl, `${ACTIVATION_PATH}/v1/activate`, 'POST', headers, items)
  );
}

/** GET /recentactivations - activation batches submitted in roughly the last 30 days. */
export async function listRecentActivations(
  creds: WatchGuardCredentials,
  opts: { offset?: number; limit?: number; sortBy?: string } = {}
): Promise<RecentActivationsResponse> {
  const baseUrl = baseUrlForRegion(creds.region);
  return withAccessToken(creds, (headers) =>
    request<RecentActivationsResponse>(baseUrl, `${ACTIVATION_PATH}/v1/recentactivations${buildQuery(opts)}`, 'GET', headers)
  );
}

/**
 * GET /activationbatchstatuses/{batchId} - per-line-item status for a batch.
 *
 * WatchGuard's own API docs document this endpoint's HTTP method as PUT
 * despite it being a pure status lookup with no request body - verified
 * against the live Activations API reference (2026-09-20). This client
 * follows the vendor's documented verb rather than "fixing" it to GET,
 * since a real PUT-with-no-body call is exactly as cheap to issue and a
 * substituted GET could not be live-verified without real credentials.
 */
export async function getActivationStatus(
  creds: WatchGuardCredentials,
  batchId: string,
  opts: { offset?: number; limit?: number; sortBy?: string } = {}
): Promise<ActivationStatusResponse> {
  const baseUrl = baseUrlForRegion(creds.region);
  return withAccessToken(creds, (headers) =>
    request<ActivationStatusResponse>(
      baseUrl,
      `${ACTIVATION_PATH}/v1/activationbatchstatuses/${encodeURIComponent(batchId)}${buildQuery(opts)}`,
      'PUT',
      headers
    )
  );
}

// ---------------------------------------------------------------------
// Operator Management (rest/platform/operator-mgmt/v1)
// ---------------------------------------------------------------------

const OPERATOR_PATH = '/rest/platform/operator-mgmt/v1';

/** POST /operators - create a new WatchGuard Cloud operator (user) account with an assigned role. */
export async function createOperator(
  creds: WatchGuardCredentials,
  input: CreateOperatorInput
): Promise<OperatorTransactionResponse> {
  const baseUrl = baseUrlForRegion(creds.region);
  return withAccessToken(creds, (headers) =>
    request<OperatorTransactionResponse>(baseUrl, `${OPERATOR_PATH}/operators`, 'POST', headers, input)
  );
}

/** PATCH /operators - update an existing operator's name/phone/role. */
export async function updateOperator(
  creds: WatchGuardCredentials,
  input: UpdateOperatorInput
): Promise<OperatorTransactionResponse> {
  const baseUrl = baseUrlForRegion(creds.region);
  return withAccessToken(creds, (headers) =>
    request<OperatorTransactionResponse>(baseUrl, `${OPERATOR_PATH}/operators`, 'PATCH', headers, input)
  );
}

/** POST /DeleteOperators - delete an operator account (vendor's own endpoint name/verb, verified against live docs). */
export async function deleteOperator(
  creds: WatchGuardCredentials,
  username: string,
  accountId: string
): Promise<OperatorTransactionResponse> {
  const baseUrl = baseUrlForRegion(creds.region);
  return withAccessToken(creds, (headers) =>
    request<OperatorTransactionResponse>(baseUrl, `${OPERATOR_PATH}/DeleteOperators`, 'POST', headers, {
      username,
      accountId,
    })
  );
}

/** GET /TransactionStatus - poll the async result of a create/update/delete operator call. */
export async function getOperatorTransactionStatus(
  creds: WatchGuardCredentials,
  transactionId: string
): Promise<OperatorTransactionStatusResponse> {
  const baseUrl = baseUrlForRegion(creds.region);
  return withAccessToken(creds, (headers) =>
    request<OperatorTransactionStatusResponse>(
      baseUrl,
      `${OPERATOR_PATH}/TransactionStatus${buildQuery({ transaction_id: transactionId })}`,
      'GET',
      headers
    )
  );
}

/** GET /OperatorsByAccountId - list every operator (user) account and role/MFA status for an account. */
export async function listOperators(
  creds: WatchGuardCredentials,
  accountId: string
): Promise<OperatorsByAccountResponse> {
  const baseUrl = baseUrlForRegion(creds.region);
  return withAccessToken(creds, (headers) =>
    request<OperatorsByAccountResponse>(
      baseUrl,
      `${OPERATOR_PATH}/OperatorsByAccountId${buildQuery({ account_id: accountId })}`,
      'GET',
      headers
    )
  );
}

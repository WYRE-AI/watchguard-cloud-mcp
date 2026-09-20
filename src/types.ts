/**
 * Long-lived credentials issued out-of-band by WatchGuard Cloud. `accessId`
 * and `password` are a read-write API credential pair from Account Settings
 * > API Access, exchanged for a short-lived OAuth access token at
 * POST /oauth/token. `apiKey` is a SEPARATE, independently-issued
 * WatchGuard-API-Key (generated in the same API-access flow) sent as its own
 * header on every request - it is not part of the OAuth exchange. `region`
 * selects which of WatchGuard's three data-storage regions to call; it
 * defaults to 'usa' and is NOT secret. See client.ts.
 */
export interface WatchGuardCredentials {
  accessId: string;
  password: string;
  apiKey: string;
  region?: WatchGuardRegion;
}

/** The three WatchGuard Cloud data-storage regions (docs: wg-cloud_urls.html). */
export type WatchGuardRegion = 'usa' | 'deu' | 'jpn';

/** Response body of POST /oauth/token (standard OAuth2 client_credentials shape). */
export interface OAuthTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

// ---------------------------------------------------------------------
// Accounts API (rest/platform/accounts/v1)
// ---------------------------------------------------------------------

export interface AccountContact {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
}

/** Account object returned by GET /accounts/{accountId}. Fields the vendor docs mark optional/expandable via `fields=`. */
export interface WatchGuardAccount {
  accountId?: string;
  name?: string;
  type?: number;
  contacts?: AccountContact[];
  parent?: Record<string, unknown>;
  delegatedParent?: Record<string, unknown>;
  addresses?: Record<string, unknown>[];
  serviceProperties?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CreateAccountInput {
  type: number;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
}

export interface UpdateAccountInput {
  name: string;
  firstName: string;
  lastName: string;
  email: string;
}

export interface ManagedAccountsResponse {
  items?: WatchGuardAccount[];
  limit?: number;
  offset?: number;
  totalItems?: number;
  [key: string]: unknown;
}

export interface DeleteAccountResponse {
  childIds?: string[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------
// Activations API (rest/platform/activation)
// ---------------------------------------------------------------------

export interface DeviceDetails {
  serialNumber?: string;
  [key: string]: unknown;
}

export interface SaasDetails {
  [key: string]: unknown;
}

export interface ActivationRequestItem {
  activationKey: string;
  accountId?: string;
  deviceDetails?: DeviceDetails;
  saasDetails?: SaasDetails;
}

export interface ActivationBatchItem {
  lineItemId?: string;
  tags?: Record<string, unknown>;
  status?: string;
}

export interface ActivationBatch {
  batchId?: string;
  batchItems?: ActivationBatchItem[];
  status?: string;
  statusUrl?: string;
}

export interface ActivateResponse {
  activations?: ActivationBatch[];
  [key: string]: unknown;
}

export interface RecentActivationsResponse {
  results?: Array<{
    activationStatus?: string;
    batchId?: string;
    created?: string;
    lastModified?: string;
    lineItemCount?: number;
    firstLineItem?: Record<string, unknown>;
  }>;
  pagination?: { offset?: number; limit?: number; totalResults?: number };
  [key: string]: unknown;
}

export interface ActivationStatusResponse {
  results?: Array<{
    lineItemId?: string;
    activationKey?: string;
    status?: string;
    created?: string;
    lastModified?: string;
    errors?: unknown[];
  }>;
  pagination?: { offset?: number; limit?: number; totalResults?: number };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------
// Operator Management API (rest/platform/operator-mgmt/v1)
// ---------------------------------------------------------------------

/** Service Provider roles: OWNER, SALES, HELPDESK, AUDITOR, NO_ACCESS. Subscriber roles: ADMINISTRATOR, ANALYST, OBSERVER, NO_ACCESS. */
export type WatchGuardOperatorRole =
  | 'OWNER'
  | 'SALES'
  | 'HELPDESK'
  | 'AUDITOR'
  | 'ADMINISTRATOR'
  | 'ANALYST'
  | 'OBSERVER'
  | 'NO_ACCESS';

export interface CreateOperatorInput {
  username: string;
  accountId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  role: WatchGuardOperatorRole;
  password?: string;
}

export interface UpdateOperatorInput {
  username: string;
  accountId: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  role?: WatchGuardOperatorRole;
}

export interface OperatorTransactionResponse {
  transaction_id?: string;
  status?: string;
  message?: string;
  [key: string]: unknown;
}

export interface OperatorTransactionStatusResponse {
  status?: string;
  transaction_status?: Array<{
    status?: 'PENDING' | 'SUCCESS' | 'FAILED';
    username?: string;
    error?: string;
  }>;
  [key: string]: unknown;
}

export interface OperatorRecord {
  accountId?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  mfa?: 'Enabled' | 'Disabled';
  userName?: string;
}

export interface OperatorsByAccountResponse {
  result?: OperatorRecord[];
  status?: string;
  [key: string]: unknown;
}

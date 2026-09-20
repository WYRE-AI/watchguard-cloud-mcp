import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAccountTool } from '../tools/accounts.js';
import { textOf } from './test-helpers.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const ENV_KEYS = ['WATCHGUARDCLOUD_ACCESS_ID', 'WATCHGUARDCLOUD_PASSWORD', 'WATCHGUARDCLOUD_API_KEY'] as const;

describe('handleAccountTool', () => {
  const fetchMock = vi.fn();
  let credCounter = 0;

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    // A unique accessId per test keeps client.ts's module-scoped access-token
    // cache from bleeding between tests (it is keyed on the full credential
    // set, so a fresh id forces a real token exchange every time).
    credCounter += 1;
    process.env.WATCHGUARDCLOUD_ACCESS_ID = `AID1-${credCounter}`;
    process.env.WATCHGUARDCLOUD_PASSWORD = 'PW1';
    process.env.WATCHGUARDCLOUD_API_KEY = 'KEY1';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('errors when credentials are missing', async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const result = await handleAccountTool('watchguardcloud_get_account', { accountId: 'ACC-1' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/No WatchGuard Cloud credentials/);
  });

  it('watchguardcloud_get_account requires accountId', async () => {
    const result = await handleAccountTool('watchguardcloud_get_account', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/accountId is required/);
  });

  it('watchguardcloud_get_account fetches the account and passes `fields` through as a comma-joined query param', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ accountId: 'ACC-1', name: 'Acme' }));

    const result = await handleAccountTool('watchguardcloud_get_account', {
      accountId: 'ACC-1',
      fields: ['contacts', 'addresses'],
    });

    expect(JSON.parse(textOf(result)).name).toBe('Acme');
    const [url] = fetchMock.mock.calls[1];
    expect(url).toBe(
      'https://api.usa.cloud.watchguard.com/rest/platform/accounts/v1/accounts/ACC-1?fields=contacts%2Caddresses'
    );
  });

  it('watchguardcloud_create_account POSTs to the parent account path with the request body', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ accountId: 'ACC-NEW' }));

    const result = await handleAccountTool('watchguardcloud_create_account', {
      parentAccountId: 'ACC-PARENT',
      type: 2,
      name: 'New Co',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
    });

    expect(JSON.parse(textOf(result)).accountId).toBe('ACC-NEW');
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api.usa.cloud.watchguard.com/rest/platform/accounts/v1/accounts/ACC-PARENT');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      type: 2,
      name: 'New Co',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
    });
  });

  it('watchguardcloud_update_account PATCHes and reports success on HTTP 204', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await handleAccountTool('watchguardcloud_update_account', {
      accountId: 'ACC-1',
      name: 'Renamed',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
    });

    expect(JSON.parse(textOf(result))).toEqual({ accountId: 'ACC-1', updated: true });
    const [, init] = fetchMock.mock.calls[1];
    expect(init.method).toBe('PATCH');
  });

  it('watchguardcloud_delete_account sends force as a query param and returns childIds', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ childIds: ['ACC-CHILD-1'] }));

    const result = await handleAccountTool('watchguardcloud_delete_account', { accountId: 'ACC-1', force: true });

    expect(JSON.parse(textOf(result)).childIds).toEqual(['ACC-CHILD-1']);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api.usa.cloud.watchguard.com/rest/platform/accounts/v1/accounts/ACC-1?force=true');
    expect(init.method).toBe('DELETE');
  });

  it('watchguardcloud_list_managed_accounts builds the children query string from paging/sort options', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ items: [], totalItems: 0 }));

    await handleAccountTool('watchguardcloud_list_managed_accounts', {
      accountId: 'ACC-1',
      sortBy: 'name',
      sortOrder: 'asc',
      limit: 25,
      offset: 0,
    });

    const [url] = fetchMock.mock.calls[1];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe('/rest/platform/accounts/v1/accounts/ACC-1/children');
    expect(parsed.searchParams.get('sortBy')).toBe('name');
    expect(parsed.searchParams.get('sortOrder')).toBe('asc');
    expect(parsed.searchParams.get('limit')).toBe('25');
    expect(parsed.searchParams.get('offset')).toBe('0');
  });
});

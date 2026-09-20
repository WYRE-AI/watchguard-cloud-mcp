import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baseUrlForRegion, getAccount, requestAccessToken } from '../client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('baseUrlForRegion', () => {
  it('maps each documented region to its hostname and defaults to usa', () => {
    expect(baseUrlForRegion('usa')).toBe('https://api.usa.cloud.watchguard.com');
    expect(baseUrlForRegion('deu')).toBe('https://api.deu.cloud.watchguard.com');
    expect(baseUrlForRegion('jpn')).toBe('https://api.jpn.cloud.watchguard.com');
    expect(baseUrlForRegion(undefined)).toBe('https://api.usa.cloud.watchguard.com');
    expect(baseUrlForRegion('not-a-region')).toBe('https://api.usa.cloud.watchguard.com');
  });
});

describe('requestAccessToken', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs grant_type=client_credentials with HTTP Basic accessId:password and returns the access token + parsed expiry', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: 'tok-123', token_type: 'bearer', expires_in: 3600, scope: 'api-access' })
    );

    const result = await requestAccessToken({ accessId: 'AID1', password: 'PW1', apiKey: 'key1' });

    expect(result.accessToken).toBe('tok-123');
    expect(result.expireAt).toBeGreaterThan(Date.now());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.usa.cloud.watchguard.com/oauth/token');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.body).toBe('grant_type=client_credentials&scope=api-access');
    const expectedBasic = Buffer.from('AID1:PW1').toString('base64');
    expect(init.headers['Authorization']).toBe(`Basic ${expectedBasic}`);
  });

  it('uses the region-specific host when a region is supplied', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'tok', expires_in: 3600 }));
    await requestAccessToken({ accessId: 'AID1', password: 'PW1', apiKey: 'key1', region: 'deu' });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.deu.cloud.watchguard.com/oauth/token');
  });

  it('throws when the vendor returns 2xx with no access_token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'invalid_client', error_description: 'Bad credentials' }));

    await expect(requestAccessToken({ accessId: 'bad', password: 'bad', apiKey: 'key' })).rejects.toThrow(
      /Bad credentials/
    );
  });

  it('throws on a 401 response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));

    await expect(requestAccessToken({ accessId: 'AID1', password: 'PW1', apiKey: 'key1' })).rejects.toThrow(
      /HTTP 401/
    );
  });

  it('falls back to a conservative TTL when expires_in is missing', async () => {
    const before = Date.now();
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'tok-no-ttl' }));
    const result = await requestAccessToken({ accessId: 'AID1', password: 'PW1', apiKey: 'key1' });
    expect(result.expireAt).toBeGreaterThan(before);
    expect(result.expireAt).toBeLessThan(before + 11 * 60_000);
  });
});

describe('getAccount - access token caching, refresh, and cache-key isolation', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exchanges an access token once, sends it as a Bearer header plus the WatchGuard-API-Key header, and reuses the cached token on a second call', async () => {
    const creds = { accessId: 'AID-CACHE', password: 'PW-CACHE', apiKey: 'key-cache' };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-cache-1', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ accountId: 'ACC-1', name: 'Acme' }));

    const result = await getAccount(creds, 'ACC-1');

    expect(result.name).toBe('Acme');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [accountUrl, accountInit] = fetchMock.mock.calls[1];
    expect(accountUrl).toBe('https://api.usa.cloud.watchguard.com/rest/platform/accounts/v1/accounts/ACC-1');
    expect(accountInit.headers['Authorization']).toBe('Bearer tok-cache-1');
    expect(accountInit.headers['WatchGuard-API-Key']).toBe('key-cache');

    // A second call with the same credentials must reuse the cached token
    // rather than re-exchanging it.
    fetchMock.mockResolvedValueOnce(jsonResponse({ accountId: 'ACC-2' }));
    await getAccount(creds, 'ACC-2');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never shares a cached access token between two credential sets that would collide under a naive colon-join', async () => {
    // accessId="A:B"/password="C" and accessId="A"/password="B:C" both
    // concatenate to "A:B:C" under a plain `${a}:${b}` join — this guards
    // the actual cache-key encoding (JSON.stringify) against that collision.
    const tenantOne = { accessId: 'A:B', password: 'C', apiKey: 'key' };
    const tenantTwo = { accessId: 'A', password: 'B:C', apiKey: 'key' };

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-tenant-one', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ accountId: 'ACC-1' }));
    await getAccount(tenantOne, 'ACC-1');

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-tenant-two', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ accountId: 'ACC-1' }));
    await getAccount(tenantTwo, 'ACC-1');

    // 4 total fetches (exchange+request per tenant) means tenant two did its
    // own token exchange rather than reusing tenant one's cached token — a
    // colon-join collision would collapse this to 3.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [, tenantTwoInit] = fetchMock.mock.calls[3];
    expect(tenantTwoInit.headers['Authorization']).toBe('Bearer tok-tenant-two');
  });

  it('also isolates the cache by region even when accessId/password/apiKey match', async () => {
    const usaCreds = { accessId: 'SAME', password: 'SAME', apiKey: 'SAME', region: 'usa' as const };
    const euCreds = { accessId: 'SAME', password: 'SAME', apiKey: 'SAME', region: 'deu' as const };

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-usa', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ accountId: 'ACC-1' }));
    await getAccount(usaCreds, 'ACC-1');

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-eu', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ accountId: 'ACC-1' }));
    await getAccount(euCreds, 'ACC-1');

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [euUrl] = fetchMock.mock.calls[2];
    expect(euUrl).toBe('https://api.deu.cloud.watchguard.com/oauth/token');
  });

  it('refreshes the access token exactly once when the vendor rejects it mid-call (401), then retries', async () => {
    const creds = { accessId: 'AID-REFRESH', password: 'PW-REFRESH', apiKey: 'key-refresh' };
    fetchMock
      // Initial exchange
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-stale', expires_in: 3600 }))
      // First account call: vendor says the token is invalid (HTTP 401)
      .mockResolvedValueOnce(jsonResponse({}, 401))
      // Forced re-exchange
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-fresh', expires_in: 3600 }))
      // Retried account call succeeds
      .mockResolvedValueOnce(jsonResponse({ accountId: 'ACC-1', name: 'Acme' }));

    const result = await getAccount(creds, 'ACC-1');

    expect(result.name).toBe('Acme');
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const [, retriedInit] = fetchMock.mock.calls[3];
    expect(retriedInit.headers['Authorization']).toBe('Bearer tok-fresh');
  });
});

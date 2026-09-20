import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleActivationTool } from '../tools/activations.js';
import { textOf } from './test-helpers.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const ENV_KEYS = ['WATCHGUARDCLOUD_ACCESS_ID', 'WATCHGUARDCLOUD_PASSWORD', 'WATCHGUARDCLOUD_API_KEY'] as const;

describe('handleActivationTool', () => {
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

  it('watchguardcloud_create_activation requires a non-empty items array', async () => {
    const result = await handleActivationTool('watchguardcloud_create_activation', { items: [] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/items is required/);
  });

  it('watchguardcloud_create_activation POSTs the items array to /activate', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ activations: [{ batchId: 'B1', status: 'Created' }] }, 202));

    const items = [{ activationKey: 'KEY-1', deviceDetails: { serialNumber: 'SN1' } }];
    const result = await handleActivationTool('watchguardcloud_create_activation', { items });

    expect(JSON.parse(textOf(result)).activations[0].batchId).toBe('B1');
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api.usa.cloud.watchguard.com/rest/platform/activation/v1/activate');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(items);
  });

  it('watchguardcloud_list_recent_activations GETs /recentactivations with paging params', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ results: [], pagination: { totalResults: 0 } }));

    await handleActivationTool('watchguardcloud_list_recent_activations', { limit: 10, sortBy: 'LastModified' });

    const [url, init] = fetchMock.mock.calls[1];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe('/rest/platform/activation/v1/recentactivations');
    expect(parsed.searchParams.get('limit')).toBe('10');
    expect(parsed.searchParams.get('sortBy')).toBe('LastModified');
    expect(init.method).toBe('GET');
  });

  it('watchguardcloud_get_activation_status requires batchId and issues the vendor-documented PUT verb', async () => {
    const missing = await handleActivationTool('watchguardcloud_get_activation_status', {});
    expect(missing.isError).toBe(true);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ lineItemId: 'L1', status: 'Success' }] }));

    const result = await handleActivationTool('watchguardcloud_get_activation_status', { batchId: 'B1' });
    expect(JSON.parse(textOf(result)).results[0].status).toBe('Success');

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api.usa.cloud.watchguard.com/rest/platform/activation/v1/activationbatchstatuses/B1');
    expect(init.method).toBe('PUT');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleOperatorTool } from '../tools/operators.js';
import { textOf } from './test-helpers.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const ENV_KEYS = ['WATCHGUARDCLOUD_ACCESS_ID', 'WATCHGUARDCLOUD_PASSWORD', 'WATCHGUARDCLOUD_API_KEY'] as const;

describe('handleOperatorTool', () => {
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

  it('watchguardcloud_create_operator POSTs to /operators with the full input', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ transaction_id: 'T1', status: 'success' }));

    const result = await handleOperatorTool('watchguardcloud_create_operator', {
      username: 'jdoe',
      accountId: 'ACC-1',
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@example.com',
      phone: '5551234567',
      role: 'ADMINISTRATOR',
    });

    expect(JSON.parse(textOf(result)).transaction_id).toBe('T1');
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api.usa.cloud.watchguard.com/rest/platform/operator-mgmt/v1/operators');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({ username: 'jdoe', accountId: 'ACC-1', role: 'ADMINISTRATOR' });
  });

  it('watchguardcloud_update_operator requires username and accountId, then PATCHes', async () => {
    const missing = await handleOperatorTool('watchguardcloud_update_operator', {});
    expect(missing.isError).toBe(true);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ transaction_id: 'T2', status: 'success' }));

    await handleOperatorTool('watchguardcloud_update_operator', {
      username: 'jdoe',
      accountId: 'ACC-1',
      role: 'OBSERVER',
    });

    const [, init] = fetchMock.mock.calls[1];
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toMatchObject({ username: 'jdoe', accountId: 'ACC-1', role: 'OBSERVER' });
  });

  it('watchguardcloud_delete_operator POSTs to /DeleteOperators (vendor-documented verb/path)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ transaction_id: 'T3', status: 'success' }));

    await handleOperatorTool('watchguardcloud_delete_operator', { username: 'jdoe', accountId: 'ACC-1' });

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api.usa.cloud.watchguard.com/rest/platform/operator-mgmt/v1/DeleteOperators');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ username: 'jdoe', accountId: 'ACC-1' });
  });

  it('watchguardcloud_get_operator_transaction_status GETs /TransactionStatus with the transaction_id query param', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ status: 'success', transaction_status: [{ status: 'SUCCESS', username: 'jdoe' }] }));

    const result = await handleOperatorTool('watchguardcloud_get_operator_transaction_status', {
      transactionId: 'T1',
    });

    expect(JSON.parse(textOf(result)).transaction_status[0].status).toBe('SUCCESS');
    const [url] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api.usa.cloud.watchguard.com/rest/platform/operator-mgmt/v1/TransactionStatus?transaction_id=T1');
  });

  it('watchguardcloud_list_operators GETs /OperatorsByAccountId with account_id query param', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ result: [{ userName: 'jdoe', mfa: 'Enabled' }], status: 'success' }));

    const result = await handleOperatorTool('watchguardcloud_list_operators', { accountId: 'ACC-1' });

    expect(JSON.parse(textOf(result)).result[0].userName).toBe('jdoe');
    const [url] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api.usa.cloud.watchguard.com/rest/platform/operator-mgmt/v1/OperatorsByAccountId?account_id=ACC-1');
  });
});

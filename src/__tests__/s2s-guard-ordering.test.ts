/**
 * S2S guard ordering vs. lazy WatchGuard OAuth exchange.
 *
 * Credential extraction in http.ts is synchronous, but client.ts then
 * exchanges AccessID/Password for a bearer token via POST /oauth/token
 * the first time an API-backed tool runs. A status-code check cannot tell
 * "the guard rejected the request before any token exchange" from "the
 * guard ran after the exchange and still returned 401". This test counts
 * calls to the WatchGuard host.
 */
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_S2S_SECRET = 'test-s2s-guard-ordering-secret-do-not-use-in-prod';
const WRONG_S2S_SECRET = 'wrong-secret-must-not-verify';
const WG_HOST = 'https://api.jpn.cloud.watchguard.com';
const ENV_ACCESS_ID = 'env-access-id-must-not-be-used';
const ENV_PASSWORD = 'env-password-must-not-be-used';
const ENV_API_KEY = 'env-api-key-must-not-be-used';
const HEADER_ACCESS_ID = 'header-access-id';
const HEADER_PASSWORD = 'header-password';
const HEADER_API_KEY = 'header-api-key';

function mintS2sHeader(secret: string, unixSeconds: number): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac('sha256', secret).update(message).digest('hex');
  return `${message},v1=${hex}`;
}

const GATEWAY_HEADERS = {
  'x-watchguardcloud-access-id': HEADER_ACCESS_ID,
  'x-watchguardcloud-password': HEADER_PASSWORD,
  'x-watchguardcloud-api-key': HEADER_API_KEY,
  'x-watchguardcloud-region': 'jpn',
};

let realFetch: typeof fetch;
let tokenCalls = 0;
let dataCalls = 0;
let unexpectedHosts: string[] = [];
let seenApiKey: string | undefined;
let seenBasic: string | undefined;
let httpServer: Server;
let boundPort = 0;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function installFetchStub(): void {
  tokenCalls = 0;
  dataCalls = 0;
  unexpectedHosts = [];
  seenApiKey = undefined;
  seenBasic = undefined;
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);

    if (url.startsWith(`http://127.0.0.1:${boundPort}`)) {
      return realFetch(input, init);
    }
    if (url.includes('cloud.watchguard.com') && !url.startsWith(WG_HOST)) {
      unexpectedHosts.push(url);
      return new Response('unexpected host', { status: 500 });
    }
    if (url.startsWith(`${WG_HOST}/oauth/token`)) {
      tokenCalls++;
      seenBasic = new Headers(init?.headers).get('authorization') ?? undefined;
      return new Response(
        JSON.stringify({ access_token: 'fake-access-token-for-test', expires_in: 3600, token_type: 'bearer' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.startsWith(WG_HOST)) {
      dataCalls++;
      seenApiKey = new Headers(init?.headers).get('watchguard-api-key') ?? undefined;
      return new Response(JSON.stringify({ accountId: 'ACC-1', name: 'Test' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(input, init);
  });
  global.fetch = stub as unknown as typeof fetch;
}

async function postToMcp(headers: Record<string, string>, body: unknown): Promise<Response> {
  return realFetch(`http://127.0.0.1:${boundPort}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const TOOLS_LIST_BODY = { jsonrpc: '2.0', method: 'tools/list', id: 1 };
const GET_ACCOUNT_BODY = {
  jsonrpc: '2.0',
  method: 'tools/call',
  params: { name: 'watchguardcloud_get_account', arguments: { accountId: 'ACC-1' } },
  id: 2,
};

beforeAll(async () => {
  realFetch = globalThis.fetch.bind(globalThis);

  process.env.MCP_TRANSPORT = 'http';
  process.env.AUTH_MODE = 'gateway';
  process.env.MCP_HTTP_PORT = '0';
  process.env.MCP_HTTP_HOST = '127.0.0.1';
  process.env.CONDUIT_S2S_SECRET = TEST_S2S_SECRET;
  process.env.WATCHGUARDCLOUD_ACCESS_ID = ENV_ACCESS_ID;
  process.env.WATCHGUARDCLOUD_PASSWORD = ENV_PASSWORD;
  process.env.WATCHGUARDCLOUD_API_KEY = ENV_API_KEY;
  process.env.WATCHGUARDCLOUD_REGION = 'usa';

  const { startHttpServer } = await import('../http.js');
  httpServer = await startHttpServer();
  const bound = httpServer.address() as AddressInfo | null;
  if (!bound || typeof bound === 'string') {
    throw new Error('HTTP server did not bind a TCP port');
  }
  boundPort = bound.port;
});

afterAll(async () => {
  global.fetch = realFetch;
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.WATCHGUARDCLOUD_ACCESS_ID;
  delete process.env.WATCHGUARDCLOUD_PASSWORD;
  delete process.env.WATCHGUARDCLOUD_API_KEY;
  delete process.env.WATCHGUARDCLOUD_REGION;
  if (!httpServer?.listening) return;
  await new Promise<void>((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(() => {
  installFetchStub();
});

describe('S2S guard ordering vs. lazy WatchGuard OAuth exchange', () => {
  it('does not reach the WatchGuard OAuth token endpoint when the S2S header is missing', async () => {
    const res = await postToMcp({ ...GATEWAY_HEADERS }, GET_ACCOUNT_BODY);

    expect(res.status).toBe(401);
    expect(tokenCalls).toBe(0);
    expect(dataCalls).toBe(0);
    expect(unexpectedHosts).toEqual([]);
  });

  it('does not reach the WatchGuard OAuth token endpoint when the S2S header is invalid', async () => {
    const res = await postToMcp(
      {
        ...GATEWAY_HEADERS,
        'x-gateway-s2s': mintS2sHeader(WRONG_S2S_SECRET, Math.floor(Date.now() / 1000)),
      },
      GET_ACCOUNT_BODY,
    );

    expect(res.status).toBe(401);
    expect(tokenCalls).toBe(0);
    expect(dataCalls).toBe(0);
    expect(unexpectedHosts).toEqual([]);
  });

  it('does not reach the WatchGuard OAuth token endpoint when gateway credential headers are missing', async () => {
    const res = await postToMcp(
      { 'x-gateway-s2s': mintS2sHeader(TEST_S2S_SECRET, Math.floor(Date.now() / 1000)) },
      GET_ACCOUNT_BODY,
    );

    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain('Missing credentials');
    expect(body).not.toContain(ENV_ACCESS_ID);
    expect(body).not.toContain(ENV_PASSWORD);
    expect(body).not.toContain(ENV_API_KEY);
    expect(tokenCalls).toBe(0);
    expect(dataCalls).toBe(0);
    expect(unexpectedHosts).toEqual([]);
  });

  it('reaches the OAuth token endpoint once when the S2S header is valid and a real tool executes', async () => {
    const res = await postToMcp(
      {
        ...GATEWAY_HEADERS,
        'x-gateway-s2s': mintS2sHeader(TEST_S2S_SECRET, Math.floor(Date.now() / 1000)),
      },
      GET_ACCOUNT_BODY,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
    expect(body.result?.isError).not.toBe(true);
    expect(JSON.stringify(body)).not.toContain(ENV_ACCESS_ID);
    expect(JSON.stringify(body)).not.toContain(ENV_PASSWORD);
    expect(JSON.stringify(body)).not.toContain(ENV_API_KEY);
    expect(JSON.stringify(body)).not.toContain(TEST_S2S_SECRET);

    expect(tokenCalls).toBe(1);
    expect(dataCalls).toBe(1);
    expect(unexpectedHosts).toEqual([]);
    expect(seenBasic).toBe(
      `Basic ${Buffer.from(`${HEADER_ACCESS_ID}:${HEADER_PASSWORD}`).toString('base64')}`,
    );
    expect(seenApiKey).toBe(HEADER_API_KEY);
  });

  it('does not reach the token endpoint for tools/list', async () => {
    const res = await postToMcp(
      {
        ...GATEWAY_HEADERS,
        'x-gateway-s2s': mintS2sHeader(TEST_S2S_SECRET, Math.floor(Date.now() / 1000)),
      },
      TOOLS_LIST_BODY,
    );

    expect(res.status).toBe(200);
    expect(tokenCalls).toBe(0);
    expect(dataCalls).toBe(0);
  });
});

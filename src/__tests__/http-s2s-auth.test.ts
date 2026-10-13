/**
 * HTTP transport fail-closed auth.
 *
 * Startup requires a real CONDUIT_S2S_SECRET unless MCP_ALLOW_INSECURE_DEV=1.
 * Known placeholders are refused even with that flag. The dev bypass binds
 * 127.0.0.1 only. A configured secret honors MCP_HTTP_HOST.
 * /mcp rejects a missing or invalid X-Gateway-S2S header.
 * AUTH_MODE=gateway rejects requests that omit vendor credential headers
 * and must not fall back to WATCHGUARDCLOUD_* in process.env.
 */

import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const getCredentialsMock = vi.hoisted(() => vi.fn());
const runWithCredentialsMock = vi.hoisted(() => vi.fn());

vi.mock('../client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client.js')>();
  return {
    ...actual,
    getCredentials: () => {
      getCredentialsMock();
      return actual.getCredentials();
    },
    runWithCredentials: ((creds, fn) => {
      runWithCredentialsMock(creds);
      return actual.runWithCredentials(creds, fn);
    }) as typeof actual.runWithCredentials,
  };
});

import { startHttpServer } from '../http.js';

const S2S_SECRET = 's2s-do-not-log-7f3a';
const ENV_ACCESS_ID = 'env-access-id-must-not-be-used';
const ENV_PASSWORD = 'env-password-must-not-be-used';
const ENV_API_KEY = 'env-api-key-must-not-be-used';

const ENV_KEYS = [
  'CONDUIT_S2S_SECRET',
  'MCP_ALLOW_INSECURE_DEV',
  'MCP_HTTP_PORT',
  'MCP_HTTP_HOST',
  'AUTH_MODE',
  'WATCHGUARDCLOUD_ACCESS_ID',
  'WATCHGUARDCLOUD_PASSWORD',
  'WATCHGUARDCLOUD_API_KEY',
  'WATCHGUARDCLOUD_REGION',
  'LOG_LEVEL',
  'MCP_TRANSPORT',
] as const;

const savedEnv = new Map<string, string | undefined>();
const servers: Server[] = [];

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac('sha256', secret).update(message).digest('hex');
  return `${message},v1=${hex}`;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  });
  return {
    text: () => lines.join('\n'),
    restore: () => spy.mockRestore(),
  };
}

function assertNoSecrets(logged: string): void {
  expect(logged).not.toContain(S2S_SECRET);
  expect(logged).not.toContain(ENV_ACCESS_ID);
  expect(logged).not.toContain(ENV_PASSWORD);
  expect(logged).not.toContain(ENV_API_KEY);
}

interface HttpResult {
  status: number;
  body: string;
}

async function sendHttp(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResult> {
  const response = await fetch(`http://127.0.0.1:${options.port}${options.path}`, {
    method: options.method,
    headers: options.headers,
    body: options.body,
  });
  return { status: response.status, body: await response.text() };
}

async function listen(): Promise<{ port: number; address: string; server: Server }> {
  const server = await startHttpServer();
  servers.push(server);
  const bound = server.address() as AddressInfo | null;
  if (!bound || typeof bound === 'string') {
    throw new Error('HTTP server did not bind a TCP port');
  }
  return { port: bound.port, address: bound.address, server };
}

function mcpHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extra,
  };
}

const accountCall = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'watchguardcloud_get_account', arguments: {} },
});

function mockExit() {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as typeof process.exit);
}

/** process.exit throws synchronously, before startHttpServer returns a promise. */
function startOrThrow(): Promise<Server> {
  return Promise.resolve().then(() => startHttpServer());
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server?.listening) continue;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

beforeEach(async () => {
  process.env.MCP_HTTP_PORT = '0';
  process.env.MCP_HTTP_HOST = '127.0.0.1';
  process.env.LOG_LEVEL = 'info';
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.AUTH_MODE;
  delete process.env.WATCHGUARDCLOUD_ACCESS_ID;
  delete process.env.WATCHGUARDCLOUD_PASSWORD;
  delete process.env.WATCHGUARDCLOUD_API_KEY;
  delete process.env.WATCHGUARDCLOUD_REGION;
  delete process.env.MCP_TRANSPORT;
  getCredentialsMock.mockReset();
  runWithCredentialsMock.mockReset();
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server?.listening) continue;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

describe('HTTP startup', () => {
  it('refuses to start when CONDUIT_S2S_SECRET is empty', async () => {
    const logs = captureStderr();
    const exitSpy = mockExit();

    try {
      await expect(startOrThrow()).rejects.toThrow('process.exit:1');
      expect(exitSpy).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toContain('Refusing to start HTTP transport');
      expect(text).toContain('CONDUIT_S2S_SECRET is empty');
      expect(text).toContain('MCP_ALLOW_INSECURE_DEV=1');
      assertNoSecrets(text);
    } finally {
      exitSpy.mockRestore();
      logs.restore();
    }
  });

  it('still refuses when MCP_ALLOW_INSECURE_DEV is not exactly 1', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = 'true';
    process.env.CONDUIT_S2S_SECRET = '   ';
    const logs = captureStderr();
    const exitSpy = mockExit();

    try {
      await expect(startOrThrow()).rejects.toThrow('process.exit:1');
      expect(logs.text()).toContain('Refusing to start HTTP transport');
      expect(logs.text()).toContain('CONDUIT_S2S_SECRET is empty');
    } finally {
      exitSpy.mockRestore();
      logs.restore();
    }
  });

  it.each(['changeme', 'ChangeMe', ' your-s2s-secret ', 'placeholder', 'secret'])(
    'refuses known placeholder CONDUIT_S2S_SECRET %j even with the dev bypass',
    async (placeholder) => {
      process.env.CONDUIT_S2S_SECRET = placeholder;
      process.env.MCP_ALLOW_INSECURE_DEV = '1';
      const logs = captureStderr();
      const exitSpy = mockExit();

      try {
        await expect(startOrThrow()).rejects.toThrow('process.exit:1');
        expect(exitSpy).toHaveBeenCalledWith(1);
        const text = logs.text();
        expect(text).toContain('Refusing to start HTTP transport');
        expect(text).toContain('known placeholder');
        expect(text).toContain('CONDUIT_S2S_SECRET');
        expect(text).not.toContain(S2S_SECRET);
      } finally {
        exitSpy.mockRestore();
        logs.restore();
      }
    },
  );

  it('allows startup with a warning when MCP_ALLOW_INSECURE_DEV=1 and binds 127.0.0.1', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    delete process.env.MCP_HTTP_HOST;
    const logs = captureStderr();
    try {
      const server = await listen();
      expect(server.address).toBe('127.0.0.1');
      const text = logs.text();
      expect(text).toContain('SECURITY WARNING');
      expect(text).toContain('CONDUIT_S2S_SECRET is empty');
      expect(text).toContain('MCP_ALLOW_INSECURE_DEV=1');
      expect(text).toContain('127.0.0.1');
      expect(text).toContain('WITHOUT service-to-service authentication');
      assertNoSecrets(text);
      expect(text).not.toContain('not a loopback address');
    } finally {
      logs.restore();
    }
  });

  it.each(['0.0.0.0', '10.1.2.3'])(
    'forces 127.0.0.1 when the dev bypass is set and MCP_HTTP_HOST is %s',
    async (host) => {
      process.env.MCP_ALLOW_INSECURE_DEV = '1';
      process.env.MCP_HTTP_HOST = host;
      const logs = captureStderr();
      try {
        const server = await listen();
        expect(server.address).toBe('127.0.0.1');
        const text = logs.text();
        expect(text).toContain(`MCP_HTTP_HOST=${host} is not a loopback address`);
        expect(text).toContain('Binding 127.0.0.1 only');
        expect(text).toContain('SECURITY WARNING');
        assertNoSecrets(text);
      } finally {
        logs.restore();
      }
    },
  );

  it('honors a non-loopback MCP_HTTP_HOST when CONDUIT_S2S_SECRET is set', async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = '0.0.0.0';
    const logs = captureStderr();
    try {
      const server = await listen();
      expect(server.address).toBe('0.0.0.0');
      expect(logs.text()).not.toContain('not a loopback address');
      assertNoSecrets(logs.text());
    } finally {
      logs.restore();
    }
  });

  it('keeps the 0.0.0.0 default when a secret is set and MCP_HTTP_HOST is unset', async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    delete process.env.MCP_HTTP_HOST;
    const logs = captureStderr();
    try {
      const server = await listen();
      expect(server.address).toBe('0.0.0.0');
      assertNoSecrets(logs.text());
    } finally {
      logs.restore();
    }
  });

  it('honors an explicit loopback MCP_HTTP_HOST when a secret is set', async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = '127.0.0.1';
    const server = await listen();
    expect(server.address).toBe('127.0.0.1');
  });
});

describe('HTTP /mcp authentication', () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = 'gateway';
    process.env.MCP_HTTP_HOST = '127.0.0.1';
    process.env.WATCHGUARDCLOUD_ACCESS_ID = ENV_ACCESS_ID;
    process.env.WATCHGUARDCLOUD_PASSWORD = ENV_PASSWORD;
    process.env.WATCHGUARDCLOUD_API_KEY = ENV_API_KEY;
    process.env.WATCHGUARDCLOUD_REGION = 'usa';
  });

  it('returns 401 when the S2S header is missing or invalid and does not log the secret', async () => {
    const logs = captureStderr();
    try {
      const server = await listen();
      const missing = await sendHttp({
        port: server.port,
        method: 'POST',
        path: '/mcp',
        headers: mcpHeaders({
          'x-watchguardcloud-access-id': 'header-access-id',
          'x-watchguardcloud-password': 'header-password',
          'x-watchguardcloud-api-key': 'header-api-key',
        }),
        body: accountCall,
      });
      const invalid = await sendHttp({
        port: server.port,
        method: 'POST',
        path: '/mcp',
        headers: mcpHeaders({
          'x-gateway-s2s': mintS2sHeader('wrong-secret'),
          'x-watchguardcloud-access-id': 'header-access-id',
          'x-watchguardcloud-password': 'header-password',
          'x-watchguardcloud-api-key': 'header-api-key',
        }),
        body: accountCall,
      });

      expect(missing.status).toBe(401);
      expect(invalid.status).toBe(401);
      expect(missing.body).toContain('X-Gateway-S2S');
      expect(invalid.body).toContain('X-Gateway-S2S');
      expect(missing.body).not.toContain(S2S_SECRET);
      expect(invalid.body).not.toContain(S2S_SECRET);
      expect(missing.body).not.toContain(ENV_ACCESS_ID);
      assertNoSecrets(logs.text());
      expect(getCredentialsMock).not.toHaveBeenCalled();
      expect(runWithCredentialsMock).not.toHaveBeenCalled();
    } finally {
      logs.restore();
    }
  });

  it('returns 401 in gateway mode without credential headers and does not use env credentials', async () => {
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: 'POST',
      path: '/mcp',
      headers: mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET) }),
      body: accountCall,
    });

    expect(response.status).toBe(401);
    expect(response.body).toContain('Missing credentials');
    expect(response.body).toContain('X-WatchGuardCloud-Access-ID');
    expect(response.body).toContain('X-WatchGuardCloud-Password');
    expect(response.body).toContain('X-WatchGuardCloud-API-Key');
    expect(response.body).not.toContain(ENV_ACCESS_ID);
    expect(response.body).not.toContain(ENV_PASSWORD);
    expect(response.body).not.toContain(ENV_API_KEY);
    expect(response.body).not.toContain(S2S_SECRET);
    expect(getCredentialsMock).not.toHaveBeenCalled();
    expect(runWithCredentialsMock).not.toHaveBeenCalled();

    const partial = await sendHttp({
      port: server.port,
      method: 'POST',
      path: '/mcp',
      headers: mcpHeaders({
        'x-gateway-s2s': mintS2sHeader(S2S_SECRET),
        'x-watchguardcloud-access-id': 'header-access-id',
        'x-watchguardcloud-password': 'header-password',
      }),
      body: accountCall,
    });
    expect(partial.status).toBe(401);
    expect(getCredentialsMock).not.toHaveBeenCalled();
    expect(runWithCredentialsMock).not.toHaveBeenCalled();
  });

  it('accepts a valid S2S header plus credential headers and uses those credentials', async () => {
    const logs = captureStderr();
    try {
      const server = await listen();
      const response = await sendHttp({
        port: server.port,
        method: 'POST',
        path: '/mcp',
        headers: mcpHeaders({
          'x-gateway-s2s': mintS2sHeader(S2S_SECRET),
          'x-watchguardcloud-access-id': 'header-access-id',
          'x-watchguardcloud-password': 'header-password',
          'x-watchguardcloud-api-key': 'header-api-key',
          'x-watchguardcloud-region': 'jpn',
        }),
        body: accountCall,
      });

      expect(response.status).toBe(200);
      expect(response.body).toContain('accountId is required');
      expect(response.body).not.toContain(S2S_SECRET);
      expect(response.body).not.toContain(ENV_ACCESS_ID);
      expect(response.body).not.toContain(ENV_PASSWORD);
      expect(response.body).not.toContain(ENV_API_KEY);
      expect(runWithCredentialsMock).toHaveBeenCalledWith({
        accessId: 'header-access-id',
        password: 'header-password',
        apiKey: 'header-api-key',
        region: 'jpn',
      });
      expect(getCredentialsMock).toHaveBeenCalled();
      assertNoSecrets(logs.text());
    } finally {
      logs.restore();
    }
  });

  it('serves /health without authentication and without reading credentials', async () => {
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: 'GET',
      path: '/health',
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { status?: string; mode?: string };
    expect(body.status).toBe('ok');
    expect(body.mode).toBe('gateway');
    expect(response.body).not.toContain(S2S_SECRET);
    expect(response.body).not.toContain(ENV_ACCESS_ID);
    expect(response.body).not.toContain(ENV_PASSWORD);
    expect(response.body).not.toContain(ENV_API_KEY);
    expect(response.body).not.toContain('credentials');
    expect(getCredentialsMock).not.toHaveBeenCalled();
    expect(runWithCredentialsMock).not.toHaveBeenCalled();
  });

  it('uses env credentials in AUTH_MODE=env after a valid S2S header', async () => {
    process.env.AUTH_MODE = 'env';
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: 'POST',
      path: '/mcp',
      headers: mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET) }),
      body: accountCall,
    });

    expect(response.status).toBe(200);
    expect(response.body).toContain('accountId is required');
    expect(response.body).not.toContain(ENV_PASSWORD);
    expect(response.body).not.toContain(ENV_API_KEY);
    expect(response.body).not.toContain(S2S_SECRET);
    expect(getCredentialsMock).toHaveBeenCalled();
    expect(runWithCredentialsMock).not.toHaveBeenCalled();
  });

  it('skips X-Gateway-S2S on the dev bypass and still rejects missing gateway credentials', async () => {
    delete process.env.CONDUIT_S2S_SECRET;
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    process.env.MCP_HTTP_HOST = '0.0.0.0';
    const server = await listen();
    expect(server.address).toBe('127.0.0.1');

    const response = await sendHttp({
      port: server.port,
      method: 'POST',
      path: '/mcp',
      headers: mcpHeaders(),
      body: accountCall,
    });

    expect(response.status).toBe(401);
    expect(response.body).toContain('Missing credentials');
    expect(response.body).not.toContain('X-Gateway-S2S');
    expect(getCredentialsMock).not.toHaveBeenCalled();
    expect(runWithCredentialsMock).not.toHaveBeenCalled();
  });
});

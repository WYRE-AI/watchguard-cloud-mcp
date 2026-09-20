import { createServer as createHttpServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { getCredentials, runWithCredentials } from './client.js';
import { logger } from './utils/logger.js';
import { verifyS2sHeader, S2S_HEADER } from './s2s-verify.js';
import type { WatchGuardRegion } from './types.js';

const S2S_SECRET = process.env.CONDUIT_S2S_SECRET || '';

function startHttpServer(): void {
  const port = parseInt(process.env.MCP_HTTP_PORT || '8080', 10);
  const host = process.env.MCP_HTTP_HOST || '0.0.0.0';
  const isGatewayMode = process.env.AUTH_MODE === 'gateway';

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/health') {
      // /health is container LIVENESS, not credential-readiness. In gateway
      // mode, credentials arrive per-request via X-WatchGuardCloud-* headers,
      // not at startup - checking getCredentials() here would 503 the
      // container permanently regardless of whether any customer has
      // connected yet.
      const creds = getCredentials();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          transport: 'http',
          mode: isGatewayMode ? 'gateway' : 'standalone',
          credentials: { configured: !!creds },
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', endpoints: ['/mcp', '/health'] }));
      return;
    }

    if (S2S_SECRET && !verifyS2sHeader(req.headers[S2S_HEADER] as string | undefined, S2S_SECRET)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.',
        })
      );
      return;
    }

    const accessId = isGatewayMode ? (req.headers['x-watchguardcloud-access-id'] as string | undefined) : undefined;
    const password = isGatewayMode ? (req.headers['x-watchguardcloud-password'] as string | undefined) : undefined;
    const apiKey = isGatewayMode ? (req.headers['x-watchguardcloud-api-key'] as string | undefined) : undefined;
    const region = isGatewayMode ? (req.headers['x-watchguardcloud-region'] as string | undefined) : undefined;

    const handle = async () => {
      // SECURITY-CRITICAL invariant: this transport MUST stay stateless
      // (sessionIdGenerator: undefined + enableJsonResponse: true).
      // Per-request tenant credentials are carried in an AsyncLocalStorage
      // context opened by runWithCredentials() below. A stateless
      // request->single-response flow keeps the tool call inside that
      // context - switching to a stateful/SSE transport would let a
      // long-lived connection serve later messages under a stale/foreign
      // credential context.
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    };

    if (accessId && password && apiKey) {
      await runWithCredentials({ accessId, password, apiKey, region: region as WatchGuardRegion | undefined }, handle);
    } else {
      await handle();
    }
  });

  httpServer.listen(port, host, () => {
    logger.info(`HTTP streaming server listening on ${host}:${port}`);
  });
}

const transport = process.env.MCP_TRANSPORT;
if (transport === 'http') {
  startHttpServer();
} else {
  import('./index.js');
}

import type { WatchGuardCredentials } from '../types.js';
import type { CallToolResult } from './types.js';

export function textResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/** Returns an error CallToolResult if credentials are missing, else null. */
export function requireCredentials(creds: WatchGuardCredentials | null): CallToolResult | null {
  if (!creds) {
    return errorResult(
      'No WatchGuard Cloud credentials configured. Set WATCHGUARDCLOUD_ACCESS_ID, WATCHGUARDCLOUD_PASSWORD, and WATCHGUARDCLOUD_API_KEY.'
    );
  }
  return null;
}

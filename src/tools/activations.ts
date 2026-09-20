import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createActivation, getActivationStatus, getCredentials, listRecentActivations } from '../client.js';
import type { CallToolResult } from './types.js';
import { errorResult, requireCredentials, textResult } from './shared.js';
import type { ActivationRequestItem } from '../types.js';

export const ACTIVATION_TOOLS: Tool[] = [
  {
    name: 'watchguardcloud_create_activation',
    description: 'Activate one or more Firebox/hardware devices or SaaS licenses by activation key.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              activationKey: { type: 'string' },
              accountId: { type: 'string' },
              deviceDetails: { type: 'object', description: 'Hardware activation details, e.g. { serialNumber }.' },
              saasDetails: { type: 'object', description: 'Software/SaaS license activation details.' },
            },
            required: ['activationKey'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'watchguardcloud_list_recent_activations',
    description: 'List activation batches submitted in roughly the last 30 days for the account.',
    inputSchema: {
      type: 'object',
      properties: {
        offset: { type: 'number' },
        limit: { type: 'number' },
        sortBy: { type: 'string', description: "e.g. 'LastModified'." },
      },
    },
  },
  {
    name: 'watchguardcloud_get_activation_status',
    description: 'Get per-line-item status for an activation batch by batch ID.',
    inputSchema: {
      type: 'object',
      properties: {
        batchId: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
        sortBy: { type: 'string' },
      },
      required: ['batchId'],
    },
  },
];

export async function handleActivationTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const creds = getCredentials();
  const missing = requireCredentials(creds);
  if (missing) return missing;

  try {
    if (name === 'watchguardcloud_create_activation') {
      const items = args.items as ActivationRequestItem[] | undefined;
      if (!items || !items.length) return errorResult('items is required and must be non-empty.');
      const result = await createActivation(creds!, items);
      return textResult(result);
    }

    if (name === 'watchguardcloud_list_recent_activations') {
      const result = await listRecentActivations(creds!, {
        offset: args.offset as number | undefined,
        limit: args.limit as number | undefined,
        sortBy: args.sortBy as string | undefined,
      });
      return textResult(result);
    }

    if (name === 'watchguardcloud_get_activation_status') {
      const batchId = args.batchId as string;
      if (!batchId) return errorResult('batchId is required.');
      const result = await getActivationStatus(creds!, batchId, {
        offset: args.offset as number | undefined,
        limit: args.limit as number | undefined,
        sortBy: args.sortBy as string | undefined,
      });
      return textResult(result);
    }

    return errorResult(`Unknown activation tool: ${name}`);
  } catch (err) {
    return errorResult((err as Error).message);
  }
}

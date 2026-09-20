import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  createOperator,
  deleteOperator,
  getCredentials,
  getOperatorTransactionStatus,
  listOperators,
  updateOperator,
} from '../client.js';
import type { CallToolResult } from './types.js';
import { errorResult, requireCredentials, textResult } from './shared.js';
import type { WatchGuardOperatorRole } from '../types.js';

const SERVICE_PROVIDER_ROLES = ['OWNER', 'SALES', 'HELPDESK', 'AUDITOR', 'NO_ACCESS'];
const SUBSCRIBER_ROLES = ['ADMINISTRATOR', 'ANALYST', 'OBSERVER', 'NO_ACCESS'];
const ALL_ROLES = [...new Set([...SERVICE_PROVIDER_ROLES, ...SUBSCRIBER_ROLES])];

export const OPERATOR_TOOLS: Tool[] = [
  {
    name: 'watchguardcloud_create_operator',
    description:
      'Create a WatchGuard Cloud operator (user) account with an assigned privilege role. Role options depend on whether the account is a Service Provider (OWNER, SALES, HELPDESK, AUDITOR, NO_ACCESS) or a Subscriber (ADMINISTRATOR, ANALYST, OBSERVER, NO_ACCESS).',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: '5-65 chars: letters, numbers, periods, hyphens, underscores, plus signs.' },
        accountId: { type: 'string' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string', description: '6-40 digits.' },
        role: { type: 'string', enum: ALL_ROLES },
        password: { type: 'string', description: 'Optional. Min 12 chars with upper/lower/number/symbol.' },
      },
      required: ['username', 'accountId', 'firstName', 'lastName', 'email', 'phone', 'role'],
    },
  },
  {
    name: 'watchguardcloud_update_operator',
    description: "Update an existing WatchGuard Cloud operator's name, phone, or privilege role.",
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        accountId: { type: 'string' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        phone: { type: 'string' },
        role: { type: 'string', enum: ALL_ROLES },
      },
      required: ['username', 'accountId'],
    },
  },
  {
    name: 'watchguardcloud_delete_operator',
    description: 'Delete a WatchGuard Cloud operator (user) account.',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        accountId: { type: 'string' },
      },
      required: ['username', 'accountId'],
    },
  },
  {
    name: 'watchguardcloud_get_operator_transaction_status',
    description: 'Poll the async result of a prior create/update/delete operator call by transaction ID.',
    inputSchema: {
      type: 'object',
      properties: {
        transactionId: { type: 'string' },
      },
      required: ['transactionId'],
    },
  },
  {
    name: 'watchguardcloud_list_operators',
    description: 'List every operator (user) account and its role/MFA status for a WatchGuard Cloud account.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string' },
      },
      required: ['accountId'],
    },
  },
];

export async function handleOperatorTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const creds = getCredentials();
  const missing = requireCredentials(creds);
  if (missing) return missing;

  try {
    if (name === 'watchguardcloud_create_operator') {
      const result = await createOperator(creds!, {
        username: args.username as string,
        accountId: args.accountId as string,
        firstName: args.firstName as string,
        lastName: args.lastName as string,
        email: args.email as string,
        phone: args.phone as string,
        role: args.role as WatchGuardOperatorRole,
        password: args.password as string | undefined,
      });
      return textResult(result);
    }

    if (name === 'watchguardcloud_update_operator') {
      const username = args.username as string;
      const accountId = args.accountId as string;
      if (!username || !accountId) return errorResult('username and accountId are required.');
      const result = await updateOperator(creds!, {
        username,
        accountId,
        firstName: args.firstName as string | undefined,
        lastName: args.lastName as string | undefined,
        phone: args.phone as string | undefined,
        role: args.role as WatchGuardOperatorRole | undefined,
      });
      return textResult(result);
    }

    if (name === 'watchguardcloud_delete_operator') {
      const username = args.username as string;
      const accountId = args.accountId as string;
      if (!username || !accountId) return errorResult('username and accountId are required.');
      const result = await deleteOperator(creds!, username, accountId);
      return textResult(result);
    }

    if (name === 'watchguardcloud_get_operator_transaction_status') {
      const transactionId = args.transactionId as string;
      if (!transactionId) return errorResult('transactionId is required.');
      const result = await getOperatorTransactionStatus(creds!, transactionId);
      return textResult(result);
    }

    if (name === 'watchguardcloud_list_operators') {
      const accountId = args.accountId as string;
      if (!accountId) return errorResult('accountId is required.');
      const result = await listOperators(creds!, accountId);
      return textResult(result);
    }

    return errorResult(`Unknown operator tool: ${name}`);
  } catch (err) {
    return errorResult((err as Error).message);
  }
}

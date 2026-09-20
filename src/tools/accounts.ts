import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createAccount, deleteAccount, getAccount, getCredentials, listManagedAccounts, updateAccount } from '../client.js';
import type { CallToolResult } from './types.js';
import { errorResult, requireCredentials, textResult } from './shared.js';

export const ACCOUNT_TOOLS: Tool[] = [
  {
    name: 'watchguardcloud_get_account',
    description: 'Get a WatchGuard Cloud account by ID, optionally expanded with contacts/addresses/service properties.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'WatchGuard Cloud account ID, e.g. ACC-1234567.' },
        fields: {
          type: 'array',
          items: { type: 'string', enum: ['contacts', 'parent', 'addresses', 'serviceProperties', 'delegatedParent'] },
          description: 'Optional extra fields to include in the response.',
        },
      },
      required: ['accountId'],
    },
  },
  {
    name: 'watchguardcloud_create_account',
    description: 'Create a new managed (child) account under a parent WatchGuard Cloud account.',
    inputSchema: {
      type: 'object',
      properties: {
        parentAccountId: { type: 'string', description: 'Parent WatchGuard Cloud account ID to create the account under.' },
        type: { type: 'number', description: '1 = Service Provider, 2 = Subscriber.' },
        name: { type: 'string' },
        firstName: { type: 'string', description: 'Primary contact first name.' },
        lastName: { type: 'string', description: 'Primary contact last name.' },
        email: { type: 'string', description: 'Primary contact email.' },
      },
      required: ['parentAccountId', 'type', 'name', 'firstName', 'lastName', 'email'],
    },
  },
  {
    name: 'watchguardcloud_update_account',
    description: "Update a managed account's name and primary contact.",
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string' },
        name: { type: 'string' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        email: { type: 'string' },
      },
      required: ['accountId', 'name', 'firstName', 'lastName', 'email'],
    },
  },
  {
    name: 'watchguardcloud_delete_account',
    description: 'Delete a managed WatchGuard Cloud account. Set force to also delete its child accounts.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string' },
        force: { type: 'boolean', description: 'Also delete child accounts. Default false.' },
      },
      required: ['accountId'],
    },
  },
  {
    name: 'watchguardcloud_list_managed_accounts',
    description: 'List accounts managed by (delegated from) a WatchGuard Cloud account, with paging/sorting/filtering.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string' },
        type: { type: 'number', description: '0 = all, 1 = Service Provider, 2 = Subscriber.' },
        sortBy: { type: 'string', enum: ['name', 'type'] },
        sortOrder: { type: 'string', enum: ['asc', 'desc'] },
        offset: { type: 'number' },
        limit: { type: 'number', description: 'Records per page; -1 returns all.' },
        name: { type: 'string', description: 'Filter by account name.' },
        includeDelegatedAccounts: { type: 'boolean' },
      },
      required: ['accountId'],
    },
  },
];

export async function handleAccountTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const creds = getCredentials();
  const missing = requireCredentials(creds);
  if (missing) return missing;

  try {
    if (name === 'watchguardcloud_get_account') {
      const accountId = args.accountId as string;
      if (!accountId) return errorResult('accountId is required.');
      const result = await getAccount(creds!, accountId, args.fields as string[] | undefined);
      return textResult(result);
    }

    if (name === 'watchguardcloud_create_account') {
      const parentAccountId = args.parentAccountId as string;
      if (!parentAccountId) return errorResult('parentAccountId is required.');
      const result = await createAccount(creds!, parentAccountId, {
        type: args.type as number,
        name: args.name as string,
        firstName: args.firstName as string,
        lastName: args.lastName as string,
        email: args.email as string,
      });
      return textResult(result);
    }

    if (name === 'watchguardcloud_update_account') {
      const accountId = args.accountId as string;
      if (!accountId) return errorResult('accountId is required.');
      await updateAccount(creds!, accountId, {
        name: args.name as string,
        firstName: args.firstName as string,
        lastName: args.lastName as string,
        email: args.email as string,
      });
      return textResult({ accountId, updated: true });
    }

    if (name === 'watchguardcloud_delete_account') {
      const accountId = args.accountId as string;
      if (!accountId) return errorResult('accountId is required.');
      const result = await deleteAccount(creds!, accountId, args.force as boolean | undefined);
      return textResult(result);
    }

    if (name === 'watchguardcloud_list_managed_accounts') {
      const accountId = args.accountId as string;
      if (!accountId) return errorResult('accountId is required.');
      const result = await listManagedAccounts(creds!, accountId, {
        type: args.type as number | undefined,
        sortBy: args.sortBy as string | undefined,
        sortOrder: args.sortOrder as string | undefined,
        offset: args.offset as number | undefined,
        limit: args.limit as number | undefined,
        name: args.name as string | undefined,
        includeDelegatedAccounts: args.includeDelegatedAccounts as boolean | undefined,
      });
      return textResult(result);
    }

    return errorResult(`Unknown account tool: ${name}`);
  } catch (err) {
    return errorResult((err as Error).message);
  }
}

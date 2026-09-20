import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ACCOUNT_TOOLS, handleAccountTool } from './accounts.js';
import { ACTIVATION_TOOLS, handleActivationTool } from './activations.js';
import { OPERATOR_TOOLS, handleOperatorTool } from './operators.js';
import type { CallToolResult } from './types.js';

export const ALL_TOOLS: Tool[] = [...ACCOUNT_TOOLS, ...ACTIVATION_TOOLS, ...OPERATOR_TOOLS];

const ACCOUNT_NAMES = new Set(ACCOUNT_TOOLS.map((t) => t.name));
const ACTIVATION_NAMES = new Set(ACTIVATION_TOOLS.map((t) => t.name));
const OPERATOR_NAMES = new Set(OPERATOR_TOOLS.map((t) => t.name));

export async function dispatchToolCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  if (ACCOUNT_NAMES.has(name)) return handleAccountTool(name, args);
  if (ACTIVATION_NAMES.has(name)) return handleActivationTool(name, args);
  if (OPERATOR_NAMES.has(name)) return handleOperatorTool(name, args);
  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
}

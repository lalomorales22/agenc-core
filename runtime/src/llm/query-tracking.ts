/**
 * `QueryTracking` — chainId + depth threading for sub-agent nesting
 * (Cut 5.4). Mirrors `claude_code/Tool.ts:QueryChainTracking`.
 *
 * Today the AgenC runtime tracks sub-agent depth via several scattered
 * mechanisms (SessionIsolationManager, parent session lookup, etc.).
 * This type collapses that surface into a single immutable record that
 * the chat-executor passes through `ExecutionContext` and that the
 * sub-agent orchestrator increments on spawn.
 *
 * @module
 */

import { randomUUID } from "node:crypto";

export interface QueryTracking {
  readonly chainId: string;
  readonly depth: number;
}

export function rootQueryTracking(): QueryTracking {
  return { chainId: randomUUID(), depth: 0 };
}

export function childQueryTracking(parent: QueryTracking): QueryTracking {
  return { chainId: parent.chainId, depth: parent.depth + 1 };
}

/**
 * Hard cap so a runaway recursive delegation can't blow the stack.
 * Mirrors claude_code's per-chain depth limit.
 */
export const MAX_QUERY_DEPTH = 8;

export function isQueryDepthExceeded(tracking: QueryTracking): boolean {
  return tracking.depth >= MAX_QUERY_DEPTH;
}

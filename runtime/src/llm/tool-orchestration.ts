/**
 * `runTools` — concurrency-safe tool dispatch (Cut 5.5).
 *
 * Mirrors `claude_code/services/tools/toolOrchestration.ts` (~188 LOC).
 *
 * Partitions tool calls into batches of:
 *  - consecutive *concurrency-safe* (read-only) tools, run in parallel
 *  - one *non-concurrency-safe* tool at a time, run serially
 *
 * The runtime decides whether a tool is concurrency-safe by consulting
 * the optional `isConcurrencySafe(args)` method on its `Tool` definition
 * (added by Cut 5.5; defaults to `false` so the change is opt-in per
 * tool). The dispatcher itself is provider-agnostic — callers pass a
 * `runOne` callback that knows how to actually invoke a single tool
 * call against the live tool handler.
 *
 * @module
 */

import type { LLMToolCall } from "./types.js";

const DEFAULT_MAX_CONCURRENCY = 10;

/** Predicate the dispatcher uses to decide whether a call can run in parallel. */
export type IsConcurrencySafeFn = (toolCall: LLMToolCall) => boolean;

/** Per-call execution function provided by the runtime. */
export type RunOneToolFn<R> = (toolCall: LLMToolCall) => Promise<R>;

export interface ToolBatch {
  readonly isConcurrencySafe: boolean;
  readonly toolCalls: readonly LLMToolCall[];
}

/**
 * Group `toolCalls` into batches honoring the partition rule:
 *   - a run of consecutive concurrency-safe calls becomes one parallel batch
 *   - any non-concurrency-safe call is its own serial batch (length 1)
 */
export function partitionToolCalls(
  toolCalls: readonly LLMToolCall[],
  isConcurrencySafe: IsConcurrencySafeFn,
): readonly ToolBatch[] {
  const batches: ToolBatch[] = [];
  for (const call of toolCalls) {
    const safe = (() => {
      try {
        return Boolean(isConcurrencySafe(call));
      } catch {
        return false;
      }
    })();
    const tail = batches[batches.length - 1];
    if (safe && tail && tail.isConcurrencySafe) {
      (tail.toolCalls as LLMToolCall[]).push(call);
    } else {
      batches.push({
        isConcurrencySafe: safe,
        toolCalls: [call],
      });
    }
  }
  return batches;
}

export interface RunToolsInput<R> {
  readonly toolCalls: readonly LLMToolCall[];
  readonly isConcurrencySafe: IsConcurrencySafeFn;
  readonly runOne: RunOneToolFn<R>;
  readonly maxConcurrency?: number;
  readonly signal?: AbortSignal;
}

export interface ToolRunRecord<R> {
  readonly toolCall: LLMToolCall;
  readonly result: R;
}

export interface RunToolsResult<R> {
  readonly records: readonly ToolRunRecord<R>[];
  readonly batches: readonly ToolBatch[];
}

/**
 * Top-level dispatcher. Sequentially walks the partitioned batches:
 *  - parallel batches use `Promise.all` (with a concurrency cap if the
 *    batch is large enough)
 *  - serial batches dispatch one call, await it, then move on
 *
 * The order of `records` matches the original order of `toolCalls` so
 * the caller can append results to the message history in lockstep with
 * the model's `tool_calls` array.
 */
export async function runTools<R>(
  input: RunToolsInput<R>,
): Promise<RunToolsResult<R>> {
  const batches = partitionToolCalls(input.toolCalls, input.isConcurrencySafe);
  const records: ToolRunRecord<R>[] = [];

  for (const batch of batches) {
    if (input.signal?.aborted) break;
    if (batch.isConcurrencySafe && batch.toolCalls.length > 1) {
      const cap = input.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
      const results: ToolRunRecord<R>[] = [];
      for (let i = 0; i < batch.toolCalls.length; i += cap) {
        const slice = batch.toolCalls.slice(i, i + cap);
        const settled = await Promise.all(
          slice.map(async (toolCall) => ({
            toolCall,
            result: await input.runOne(toolCall),
          })),
        );
        results.push(...settled);
      }
      records.push(...results);
    } else {
      for (const toolCall of batch.toolCalls) {
        if (input.signal?.aborted) break;
        const result = await input.runOne(toolCall);
        records.push({ toolCall, result });
      }
    }
  }

  return { records, batches };
}

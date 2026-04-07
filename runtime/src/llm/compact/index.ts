/**
 * Layered compaction (Cut 5.1, claude_code-alignment).
 *
 * Replaces the legacy `prompt-budget.ts` ad-hoc compaction with a
 * `claude_code/services/compact/`-style ordered chain:
 *
 *     snip → microcompact → autocompact   (per-iteration)
 *     reactiveCompact                     (post-error 413 fallback)
 *
 * Each layer is a small pure function that takes `(messages, state)`
 * and returns `{ messages, state, boundary?, action }`. The chain is
 * driven from the chat-executor's iteration loop in the order above.
 *
 * The implementations here are intentionally minimal — they ship the
 * shape and the integration points so the rest of the runtime can
 * call them, with bigger heuristics moved into each layer over time.
 *
 * @module
 */

import type { LLMMessage, LLMUsage } from "../types.js";
import { applySnip, type SnipState, createSnipState } from "./snip.js";
import {
  applyMicrocompact,
  type MicrocompactState,
  createMicrocompactState,
} from "./microcompact.js";
import {
  applyAutocompact,
  type AutoCompactTrackingState,
  createAutoCompactTrackingState,
} from "./autocompact.js";
import {
  type ReactiveCompactState,
  createReactiveCompactState,
} from "./reactive-compact.js";

export {
  applySnip,
  createSnipState,
  type SnipState,
} from "./snip.js";
export {
  applyMicrocompact,
  createMicrocompactState,
  type MicrocompactState,
} from "./microcompact.js";
export {
  applyAutocompact,
  createAutoCompactTrackingState,
  type AutoCompactTrackingState,
} from "./autocompact.js";
export {
  applyReactiveCompact,
  createReactiveCompactState,
  type ReactiveCompactState,
} from "./reactive-compact.js";
export {
  tokenCountWithEstimation,
  type TokenCountInput,
} from "./token-count.js";
export {
  ESCALATED_MAX_TOKENS,
  DEFAULT_AUTOCOMPACT_THRESHOLD_TOKENS,
  DEFAULT_SNIP_GAP_MS,
  DEFAULT_MICROCOMPACT_GAP_MS,
} from "./constants.js";

/**
 * Aggregate state passed across iterations of the executor loop.
 * Each layer owns its own slice; the combined object is what the
 * executor stores between turns.
 */
export interface CompactionState {
  readonly snip: SnipState;
  readonly microcompact: MicrocompactState;
  readonly autocompact: AutoCompactTrackingState;
  readonly reactive: ReactiveCompactState;
}

export function createCompactionState(): CompactionState {
  return {
    snip: createSnipState(),
    microcompact: createMicrocompactState(),
    autocompact: createAutoCompactTrackingState(),
    reactive: createReactiveCompactState(),
  };
}

export interface PerIterationCompactInput {
  readonly messages: readonly LLMMessage[];
  readonly state: CompactionState;
  readonly autocompactThresholdTokens?: number;
  readonly lastResponseUsage?: LLMUsage;
  readonly nowMs?: number;
}

export interface PerIterationCompactResult {
  readonly messages: readonly LLMMessage[];
  readonly state: CompactionState;
  readonly snipBoundary?: LLMMessage;
  readonly microcompactBoundary?: LLMMessage;
  readonly autocompactBoundary?: LLMMessage;
  readonly compactedThisIteration: boolean;
  readonly compactedActions: readonly (
    | "snip"
    | "microcompact"
    | "autocompact"
  )[];
}

/**
 * Run snip → microcompact → autocompact in order, threading messages and
 * state through each. Each layer can add a boundary message that the
 * caller should yield to the SDK / log.
 */
export function applyPerIterationCompaction(
  input: PerIterationCompactInput,
): PerIterationCompactResult {
  const actions: ("snip" | "microcompact" | "autocompact")[] = [];
  let messages = input.messages;
  let state = input.state;
  let snipBoundary: LLMMessage | undefined;
  let microcompactBoundary: LLMMessage | undefined;
  let autocompactBoundary: LLMMessage | undefined;
  const nowMs = input.nowMs ?? Date.now();

  const snipResult = applySnip({
    messages,
    state: state.snip,
    nowMs,
  });
  if (snipResult.action === "snipped") {
    actions.push("snip");
    messages = snipResult.messages;
    state = { ...state, snip: snipResult.state };
    snipBoundary = snipResult.boundary;
  }

  const microResult = applyMicrocompact({
    messages,
    state: state.microcompact,
    nowMs,
  });
  if (microResult.action === "microcompacted") {
    actions.push("microcompact");
    messages = microResult.messages;
    state = { ...state, microcompact: microResult.state };
    microcompactBoundary = microResult.boundary;
  }

  const autoResult = applyAutocompact({
    messages,
    state: state.autocompact,
    thresholdTokens: input.autocompactThresholdTokens,
    lastResponseUsage: input.lastResponseUsage,
  });
  if (autoResult.action === "autocompacted") {
    actions.push("autocompact");
    messages = autoResult.messages;
    state = { ...state, autocompact: autoResult.state };
    autocompactBoundary = autoResult.boundary;
  }

  return {
    messages,
    state,
    snipBoundary,
    microcompactBoundary,
    autocompactBoundary,
    compactedThisIteration: actions.length > 0,
    compactedActions: actions,
  };
}

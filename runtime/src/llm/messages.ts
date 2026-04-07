/**
 * `normalizeMessagesForAPI` — pure function that prepares an in-memory
 * `LLMMessage[]` for an API call. Mirrors
 * `claude_code/utils/messages.ts:normalizeMessagesForAPI`.
 *
 * Cut 5.8 of the claude_code-alignment refactor. The runtime today
 * scatters this normalization across `chat-executor-text.ts`,
 * `chat-executor.ts`, and provider adapters. This module collects the
 * pure normalization steps so they can be tested and reused.
 *
 * Steps in order:
 *   1. Strip "virtual" / boundary system messages whose content starts
 *      with `[snip]`, `[microcompact]`, `[autocompact]`,
 *      `[reactive-compact]`, or `[boundary]`.
 *   2. Drop empty assistant content unless that message is the very
 *      last one in the array.
 *   3. Merge consecutive same-role messages of role `user` so the API
 *      sees alternation.
 *   4. Drop tool result messages whose `toolCallId` does not match any
 *      preceding assistant `tool_calls` entry.
 *
 * @module
 */

import type { LLMMessage } from "./types.js";

const BOUNDARY_PREFIXES = [
  "[snip]",
  "[microcompact]",
  "[autocompact]",
  "[reactive-compact]",
  "[boundary]",
];

export function normalizeMessagesForAPI(
  messages: readonly LLMMessage[],
): readonly LLMMessage[] {
  const stripped: LLMMessage[] = [];
  for (const message of messages) {
    if (message.role === "system" && typeof message.content === "string") {
      if (BOUNDARY_PREFIXES.some((prefix) => message.content.toString().startsWith(prefix))) {
        continue;
      }
    }
    stripped.push(message);
  }

  // Drop empty assistant content (except the last message — providers
  // will surface that explicitly so the caller can recover).
  const nonEmpty: LLMMessage[] = [];
  for (let i = 0; i < stripped.length; i++) {
    const message = stripped[i];
    if (!message) continue;
    const isLast = i === stripped.length - 1;
    if (
      !isLast &&
      message.role === "assistant" &&
      isEmptyContent(message.content) &&
      !(message.toolCalls && message.toolCalls.length > 0)
    ) {
      continue;
    }
    nonEmpty.push(message);
  }

  // Merge consecutive user messages.
  const merged: LLMMessage[] = [];
  for (const message of nonEmpty) {
    const tail = merged[merged.length - 1];
    if (
      tail &&
      tail.role === "user" &&
      message.role === "user" &&
      typeof tail.content === "string" &&
      typeof message.content === "string"
    ) {
      merged[merged.length - 1] = {
        ...tail,
        content: `${tail.content}\n\n${message.content}`,
      };
    } else {
      merged.push(message);
    }
  }

  // Drop orphan tool messages.
  const seenToolCallIds = new Set<string>();
  const final: LLMMessage[] = [];
  for (const message of merged) {
    if (message.role === "assistant" && message.toolCalls) {
      for (const call of message.toolCalls) {
        seenToolCallIds.add(call.id);
      }
    }
    if (message.role === "tool") {
      const toolCallId =
        (message as { toolCallId?: string }).toolCallId ??
        (message as { tool_call_id?: string }).tool_call_id;
      if (!toolCallId || !seenToolCallIds.has(toolCallId)) {
        continue;
      }
    }
    final.push(message);
  }
  return final;
}

function isEmptyContent(content: LLMMessage["content"]): boolean {
  if (typeof content === "string") {
    return content.trim().length === 0;
  }
  if (Array.isArray(content)) {
    if (content.length === 0) return true;
    return content.every((part) => {
      if (part && typeof part === "object" && part.type === "text") {
        return part.text.trim().length === 0;
      }
      return false;
    });
  }
  return false;
}
